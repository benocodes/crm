import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deriveTools } from '../mcp/tools.js'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { generate } from '../../scripts/golden.js'
import { FIXTURES } from '../test/golden/fixtures.js'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { coldStorage } from '../test/storage.js'
import { fakeUserAuthenticator } from '../test/user-auth.js'

// [[CORE554]] P7 (decision 554.7): the wire of contacts, companies, deals and tasks did not change when their definitions became declarations.
// `fixtures/wire-core554/` was captured on `main` at f4c13a2, before the first edit (`WIRE_SNAPSHOT=write pnpm -C packages/api test <this file>`
// rewrites them: only ever on a base that is meant to be the new truth). The parts: the two OpenAPI documents, the MCP tool list, the `schema.get`
// document, the golden generator's text for every fixture (generator output, not `golden:check`, which is stale on main, #323), and the error
// bodies of a fixed set of refused inputs per resource. Ids in the error bodies are masked.
const DIR = fileURLToPath(new URL('../../fixtures/wire-core554/', import.meta.url))
const WRITE = process.env.WIRE_SNAPSHOT === 'write'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const mask = (v: unknown) => JSON.parse(JSON.stringify(v).replace(UUID, '<uuid>'))

/**
 * The big parts (the documents, the tool list, the golden text) are held by the SHA-256 of their JSON text, key order included, in `digests.json`;
 * the error bodies are small and held whole in `errors.json`. `WIRE_DUMP_DIR=<dir>` also writes every part whole there (run it on `main` and on the
 * branch, then diff the directories) so a digest that moved can be explained.
 */
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const seen: Record<string, string> = {}
function check(name: string, actual: unknown): void {
  const dump = process.env.WIRE_DUMP_DIR
  if (dump) {
    mkdirSync(dump, { recursive: true })
    writeFileSync(`${dump}/${name}.json`, `${JSON.stringify(actual, null, 1)}\n`)
  }
  if (name === 'errors') {
    if (WRITE) {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(`${DIR}errors.json`, `${JSON.stringify(actual, null, 1)}\n`)
    } else expect(actual).toEqual(JSON.parse(readFileSync(`${DIR}errors.json`, 'utf-8')))
    return
  }
  seen[name] = digest(actual)
  if (WRITE) {
    mkdirSync(DIR, { recursive: true })
    const prior = existsSync(`${DIR}digests.json`) ? JSON.parse(readFileSync(`${DIR}digests.json`, 'utf-8')) : {}
    writeFileSync(`${DIR}digests.json`, `${JSON.stringify({ ...prior, ...seen }, null, 1)}\n`)
  } else
    expect(seen[name], `${name} differs from main`).toBe(JSON.parse(readFileSync(`${DIR}digests.json`, 'utf-8'))[name])
}

describe('the documents', () => {
  const registry = createVibaseRegistry()
  const app = createApp({ storage: coldStorage(), registry, userAuthenticator: fakeUserAuthenticator() })
  it('the REST OpenAPI documents', async () => {
    check('openapi-api', await (await app.request('/api/v1/openapi.json')).json())
    check('openapi-meta', await (await app.request('/meta/v1/openapi.json')).json())
  })
  it('the MCP tool list (names, input and output schemas, descriptions)', () => {
    check(
      'mcp-tools',
      deriveTools(registry).map((e) => e.tool),
    )
  })
  it('the golden generator output, every fixture', async () => {
    const out: Record<string, string> = {}
    for (const f of FIXTURES) out[f.file] = await generate(f.resource, f.scenarios)
    check('golden', out)
  }, 120_000)
})

describe('schema.get and the refused inputs', () => {
  let k: ActionKit
  let owner: Actor
  beforeAll(async () => {
    k = await openActionKit()
    await k.reset()
    owner = k.owner
  })
  afterAll(() => k.close())

  it('the schema.get document', async () => {
    const r = await k.call(owner, 'GET', '/meta/v1/schema')
    expect(r.status).toBe(200)
    check('schema-get', r.body)
  })

  it('the error bodies of the fixed refusals, per resource', async () => {
    const pipeline = (await k.call(owner, 'POST', '/meta/v1/pipelines', { name: 'P' })).body.id
    const stage = (
      await k.call(owner, 'POST', '/meta/v1/pipeline-stages', {
        pipeline_id: pipeline,
        name: 'Open',
        kind: 'open',
        position: 1,
      })
    ).body.id
    const base: Record<string, Record<string, unknown>> = {
      contacts: { name: 'N' },
      companies: { name: 'N' },
      deals: { name: 'N', stage_id: stage },
      tasks: { title: 'N' },
    }
    const nameField: Record<string, string> = { contacts: 'name', companies: 'name', deals: 'name', tasks: 'title' }
    const longName: Record<string, number> = { contacts: 501, companies: 501, deals: 201, tasks: 501 }
    const rows: Record<string, string> = {}
    for (const kind of Object.keys(base)) {
      rows[kind] = (
        await k.call(owner, 'POST', `/api/v1/${kind}`, {
          ...base[kind],
          ...(kind === 'companies' ? { domain: 'a.example' } : {}),
        })
      ).body.id
    }
    const cases: Record<string, Array<[string, Record<string, unknown>]>> = {}
    for (const kind of Object.keys(base)) {
      const nf = nameField[kind]!
      const list: Array<[string, Record<string, unknown>]> = [
        ['over-long name', { [nf]: 'x'.repeat(longName[kind]!) }],
        ['empty name', { [nf]: '   ' }],
        ['null name', { [nf]: null }],
        ['number name', { [nf]: 5 }],
        ['unknown key', { bogus: 1 }],
        ['id', { id: '00000000-0000-7000-8000-000000000001' }],
        ['organization_id', { organization_id: '00000000-0000-7000-8000-000000000001' }],
        ['created_by', { created_by: '00000000-0000-7000-8000-000000000001' }],
        ['created_at', { created_at: '2026-01-01T00:00:00Z' }],
        ['deleted_at', { deleted_at: null }],
        ['bad bag', { additional_props: { nest: { a: 1 } } }],
        ['bag not object', { additional_props: 'x' }],
      ]
      if (kind === 'contacts') {
        list.push(
          ['merged_into_id', { merged_into_id: '00000000-0000-7000-8000-000000000001' }],
          ['company_id not uuid', { company_id: 'nope' }],
          ['company_id absent', { company_id: '00000000-0000-7000-8000-000000000001' }],
          ['last_contacted_at', { last_contacted_at: null }],
          ['status', { status: 'open' }],
        )
      }
      if (kind === 'companies') {
        list.push(
          ['domain long', { domain: 'd'.repeat(254) }],
          ['domain number', { domain: 5 }],
          ['domain taken', { domain: 'a.example' }],
        )
      }
      if (kind === 'deals') {
        list.push(
          ['bad currency', { currency: 'EURO' }],
          ['currency digits', { currency: '12A' }],
          ['amount without currency', { amount_minor: 100 }],
          ['negative amount', { amount_minor: -1, currency: 'USD' }],
          ['fractional amount', { amount_minor: 1.5, currency: 'USD' }],
          ['huge amount', { amount_minor: 1e300, currency: 'USD' }],
          ['bad date', { expected_close_date: '2026-13-45' }],
          ['datetime date', { expected_close_date: '2026-01-01T00:00:00Z' }],
          ['owner not uuid', { owner_id: 'x' }],
          ['owner absent', { owner_id: '00000000-0000-7000-8000-000000000001' }],
          ['stage_id', { stage_id: stage }],
          ['stage_id bad', { stage_id: 'x' }],
          ['pipeline_id', { pipeline_id: pipeline }],
          ['closed_at', { closed_at: '2026-01-01T00:00:00Z' }],
          ['status', { status: 'won' }],
        )
      }
      if (kind === 'tasks') {
        list.push(
          ['status out of enum', { status: 'wip' }],
          ['status won', { status: 'won' }],
          ['description long', { description: 'n'.repeat(10_001) }],
          ['due_at bad', { due_at: 'tomorrow' }],
          ['due_at no offset', { due_at: '2026-01-01T00:00:00' }],
          ['assignee not uuid', { assignee_id: 'x' }],
          ['assignee absent', { assignee_id: '00000000-0000-7000-8000-000000000001' }],
          ['completed_at', { completed_at: '2026-01-01T00:00:00Z' }],
        )
      }
      cases[kind] = list
    }
    const out: Record<string, unknown> = {}
    for (const [kind, list] of Object.entries(cases)) {
      for (const [label, patch] of list) {
        const create = await k.call(owner, 'POST', `/api/v1/${kind}`, { ...base[kind], ...patch })
        const update = await k.call(owner, 'PATCH', `/api/v1/${kind}/${rows[kind]}`, patch)
        out[`${kind} create: ${label}`] = mask({ status: create.status, body: create.body })
        out[`${kind} update: ${label}`] = mask({ status: update.status, body: update.body })
      }
      const emptyCreate = await k.call(owner, 'POST', `/api/v1/${kind}`, {})
      out[`${kind} create: empty body`] = mask({ status: emptyCreate.status, body: emptyCreate.body })
      const badFilter = await k.call(owner, 'GET', `/api/v1/${kind}?sort=bogus&limit=0`)
      out[`${kind} list: bad sort and limit`] = mask({ status: badFilter.status, body: badFilter.body })
    }
    const dealFilter = await k.call(owner, 'GET', '/api/v1/deals?currency=eq.usd&amount_minor=gt.x')
    out['deals list: bad amount filter'] = mask({ status: dealFilter.status, body: dealFilter.body })
    check('errors', out)
  })
})
