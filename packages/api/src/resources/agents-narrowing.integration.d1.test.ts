import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// [[CORE669]] ([[CORE666]] D5, D6): agents.update narrows a connector (a delegated agent) only within what the person approved (`consented_scopes`, or the record when NULL), and every scope change on it says the narrowing is not lasting.
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  app = createApp({ storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})

const SCOPES = ['agents:read', 'agents:write', 'events:read']
const call = async (method: string, path: string, body?: unknown) => {
  const token = mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes: SCOPES, kind: 'user' })
  const res = await app.request(`https://vibase.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
}
const patch = (id: string, body: unknown) => call('PATCH', `/meta/v1/agents/${id}`, body)
const mcpPatch = (id: string, body: Record<string, unknown>) =>
  call('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'agents_update', arguments: { id, ...body } },
  })

const NOTICE =
  "this connector's scopes follow what the person approves when signing in: a later sign-in that approves a different list replaces this change. For a limit no sign-in can change, connect it signed in as an agent account"
const refusalMessage = (s: string) =>
  `${s} was not approved when this connector signed in: the person reconnects it and approves ${s}; for a limit no sign-in can change, use an agent account`

let seeded = 0
const nextId = () => `0190b2c4-0000-7000-8000-0000000f${String(++seeded).padStart(4, '0')}`
/** A delegated agent: `consented` is the stored consent (null: the column is NULL), `record` its scopes now. */
const seedConnector = async (record: string[], consented: string[] | null) => {
  const id = nextId()
  await e.insert('principals', { id, kind: 'agent', created_at: '2026-01-01T00:00:00.000Z' })
  await e.insert('agents', {
    id,
    name: `Connector ${seeded}`,
    scopes: record,
    disabled_at: null,
    auth_provider: 'better-auth',
    auth_client_id: `client_${seeded}`,
    delegated_by: e.userId,
    consented_scopes: consented,
  })
  return id
}
const agentRow = async (id: string) => (await e.rows('agents')).find((r: any) => r.id === id)
const eventCount = async () => (await e.events()).length

const STORED = { record: ['contacts:read'], consented: ['contacts:read', 'deals:read', 'tags:read'] }
const FROM_RECORD = { record: ['contacts:read', 'tags:read'], consented: null }

describe('1. D5: the update stays within the consent (matrix: form x bound source)', () => {
  type Case = { form: string; body: Record<string, unknown>; offender: string | null; after?: string[] }
  const table: [string, { record: string[]; consented: string[] | null }, Case[]][] = [
    [
      'consented_scopes stored (narrower than the record would allow)',
      STORED,
      [
        { form: 'add_scopes outside', body: { add_scopes: ['notes:read'] }, offender: 'notes:read' },
        {
          form: 'add_scopes back inside',
          body: { add_scopes: ['deals:read'] },
          offender: null,
          after: ['contacts:read', 'deals:read'],
        },
        { form: 'remove_scopes', body: { remove_scopes: ['contacts:read'] }, offender: null, after: [] },
        { form: 'scopes outside', body: { scopes: ['contacts:read', 'notes:read'] }, offender: 'notes:read' },
        { form: 'scopes mixing in and out', body: { scopes: ['deals:read', 'notes:read'] }, offender: 'notes:read' },
        {
          form: 'scopes put back inside',
          body: { scopes: ['contacts:read', 'tags:read'] },
          offender: null,
          after: ['contacts:read', 'tags:read'],
        },
      ],
    ],
    [
      'consented_scopes NULL (the bound is the record)',
      FROM_RECORD,
      [
        { form: 'add_scopes outside', body: { add_scopes: ['deals:read'] }, offender: 'deals:read' },
        { form: 'remove_scopes', body: { remove_scopes: ['tags:read'] }, offender: null, after: ['contacts:read'] },
        { form: 'scopes outside', body: { scopes: ['contacts:read', 'deals:read'] }, offender: 'deals:read' },
        { form: 'scopes narrower', body: { scopes: ['tags:read'] }, offender: null, after: ['tags:read'] },
      ],
    ],
  ]
  for (const [source, seed, cases] of table)
    for (const c of cases)
      it(`${source}: ${c.form} ${c.offender ? 'is 409 scope_not_consented, nothing written' : 'succeeds'}`, async () => {
        const id = await seedConnector(seed.record, seed.consented)
        const rowBefore = await agentRow(id)
        const eventsBefore = await eventCount()
        const r = await patch(id, c.body)
        if (c.offender) {
          expect(r.status, JSON.stringify(r.body)).toBe(409)
          expect(r.body.error.code).toBe('scope_not_consented')
          expect(r.body.error.message).toBe(refusalMessage(c.offender))
          expect(await agentRow(id)).toEqual(rowBefore)
          expect(await eventCount()).toBe(eventsBefore)
        } else {
          expect(r.status, JSON.stringify(r.body)).toBe(200)
          expect(r.body.scopes).toEqual(c.after)
          expect(r.body).not.toHaveProperty('consented_scopes')
          expect((await agentRow(id))!.consented_scopes).toEqual(rowBefore!.consented_scopes)
          expect(await eventCount()).toBe(eventsBefore + 1)
        }
      })

  it('a rename and a disable leave the bound out of it', async () => {
    const id = await seedConnector(FROM_RECORD.record, FROM_RECORD.consented)
    expect((await patch(id, { name: 'Renamed' })).status).toBe(200)
    expect((await patch(id, { disabled: true })).status).toBe(200)
  })

  it('an agent account and an API-key agent may still be given a scope no consent listed', async () => {
    const key = nextId()
    await e.insert('principals', { id: key, kind: 'agent', created_at: '2026-01-01T00:00:00.000Z' })
    await e.insert('agents', { id: key, name: 'Key', scopes: [], disabled_at: null })
    const added = await patch(key, { add_scopes: ['notes:read'] })
    expect(added.status).toBe(200)
    expect(added.body.scopes).toEqual(['notes:read'])
    const acct = nextId()
    await e.insert('principals', { id: acct, kind: 'agent', created_at: '2026-01-01T00:00:00.000Z' })
    await e.insert('agents', {
      id: acct,
      name: 'Account',
      scopes: [],
      disabled_at: null,
      auth_provider: 'better-auth',
      auth_subject: 'subject_account',
      consented_scopes: null,
    })
    const accountAdd = await patch(acct, { add_scopes: ['notes:read'] })
    expect(accountAdd.status, JSON.stringify(accountAdd.body)).toBe(200)
    expect(accountAdd.body.scopes).toEqual(['notes:read'])
  })
})

describe('2. D5 on the surfaces', () => {
  it('REST answers 409 with the code; MCP answers the tool error with the same code and message', async () => {
    const id = await seedConnector(STORED.record, STORED.consented)
    const rest = await patch(id, { add_scopes: ['notes:read'] })
    expect(rest.status).toBe(409)
    expect(rest.body.error).toMatchObject({ code: 'scope_not_consented', message: refusalMessage('notes:read') })
    const mcp = await mcpPatch(id, { add_scopes: ['notes:read'] })
    expect(mcp.body.result.isError).toBe(true)
    expect(mcp.body.result.structuredContent.error).toMatchObject({
      code: 'scope_not_consented',
      message: refusalMessage('notes:read'),
    })
  })

  it('the operation description names scope_not_consented', async () => {
    const doc = await call('GET', '/meta/v1/openapi.json')
    const op = doc.body.paths['/meta/v1/agents/{id}'].patch
    expect(op.description).toContain('scope_not_consented')
    expect(op.description).not.toContain('reconnect it')
  })
})

describe('3. D6: the notice', () => {
  const bodies: [string, Record<string, unknown>, string | null][] = [
    ['an add back inside the consent', { add_scopes: ['deals:read'] }, NOTICE],
    ['a removal', { remove_scopes: ['contacts:read'] }, NOTICE],
    ['a whole list that differs', { scopes: ['tags:read'] }, NOTICE],
    ['a rename', { name: 'Renamed' }, null],
    ['a disable', { disabled: true }, null],
    ['the removal of a scope not on the record', { remove_scopes: ['tags:read'] }, null],
    ['the same whole list', { scopes: ['contacts:read'] }, null],
  ]
  for (const [label, body, expected] of bodies)
    it(`a delegated agent: ${label} answers ${expected === null ? 'null' : 'the notice'}`, async () => {
      const id = await seedConnector(STORED.record, STORED.consented)
      const r = await patch(id, body)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.sign_in_notice).toBe(expected)
      if (r.body.sign_in_notice !== null) expect(r.body.sign_in_notice).not.toContain('reconnect the connector')
    })

  it('an agent account keeps its notice and an API-key agent null', async () => {
    const acct = nextId()
    await e.insert('principals', { id: acct, kind: 'agent', created_at: '2026-01-01T00:00:00.000Z' })
    await e.insert('agents', {
      id: acct,
      name: 'Account',
      scopes: [],
      disabled_at: null,
      auth_provider: 'better-auth',
      auth_subject: 'subject_account2',
    })
    const a = await patch(acct, { add_scopes: ['notes:read'] })
    expect(a.body.sign_in_notice).toContain('vibase login')
    const key = nextId()
    await e.insert('principals', { id: key, kind: 'agent', created_at: '2026-01-01T00:00:00.000Z' })
    await e.insert('agents', { id: key, name: 'Key', scopes: [], disabled_at: null })
    expect((await patch(key, { add_scopes: ['notes:read'] })).body.sign_in_notice).toBeNull()
  })
})
