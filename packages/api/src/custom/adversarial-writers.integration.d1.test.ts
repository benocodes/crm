import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ActionKit, Actor } from '../test/action-kit.js'
import { baseBody, pathOf, type Resource } from '../test/extension-kit.js'
import {
  DEFAULT_LEVEL,
  REF,
  clearReferences,
  expectUntouched,
  guardViolations,
  openGuardedKit,
  rowsOf,
} from '../test/guarded-kit.js'

// [[CORE565]] obligations 2, 3, 6 (REST and the rail): on a database whose four built-ins each carry a checked field, a NOT NULL DEFAULT field, a unique field and a reference, every system writer that does not go through the
// generic CRUD succeeds, creates its rows at the defaults (the default in the required column, NULL elsewhere) and leaves every guard satisfied. Capture and the form submission are in `adversarial-capture.integration.d1.test.ts`.
let k: ActionKit
let owner: Actor
let proposer: Actor
beforeAll(async () => {
  k = await openGuardedKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await clearReferences(k.d1)
  await k.reset()
  owner = k.owner
  proposer = await k.actor('proposer', 'agent', [
    'contacts:request_approval',
    'companies:request_approval',
    'deals:request_approval',
    'tasks:request_approval',
    'action_requests:read',
  ])
})
const AR = '/api/v1/action-requests'
const ok = (r: { status: number; body: any }, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status)
  return r.body
}
const make = async (r: Resource, body: Record<string, unknown> = {}, n = 1) =>
  ok(await k.call(owner, 'POST', pathOf(r), { ...(await baseBody(k, owner, r, n)), ...body }), 201) as Record<
    string,
    any
  >
const row = async (r: Resource, id: string) => (await rowsOf(k.d1, r, 'id = ?', id))[0]!
const satisfied = async () => expect(await guardViolations(k.d1)).toEqual([])
/** Proposes `operation` as the agent and has the owner approve it: the rail executes it. */
const viaRail = async (operation: string, args: Record<string, unknown>) => {
  const proposed = ok(await k.call(proposer, 'POST', AR, { operation, arguments: args, reason: 'because' }), 201)
  const approved = ok(await k.call(owner, 'POST', `${AR}/${proposed.id}/approve`))
  expect(approved.status).toBe('executed')
}

describe('identities.resolve', () => {
  it('creates two new contacts in one call, then two more in another: each at the defaults, no collision', async () => {
    const resolve = (...values: string[]) =>
      k.call(owner, 'POST', '/api/v1/identities/resolve', {
        identities: values.map((value) => ({ kind: 'email', value, name: value })),
      })
    const first = ok(await resolve('a@guard.test', 'b@guard.test')) as { data: { created: boolean }[] }
    expect(first.data.map((d) => d.created)).toEqual([true, true])
    ok(await resolve('c@guard.test', 'd@guard.test'))
    const rows = await rowsOf(k.d1, 'contacts')
    expect(rows).toHaveLength(4)
    for (const r of rows) expectUntouched(r, 'contacts')
    await satisfied()
  })
})

describe('contacts.merge under the unique index', () => {
  const merge = (survivor: string, source: string) =>
    k.call(owner, 'POST', `${pathOf('contacts')}/${survivor}/merge`, { source_id: source })
  it('the source holds a unique value and the survivor none: the value moves, the tombstone keeps it, the index is satisfied', async () => {
    const survivor = await make('contacts', { name: 'Same' })
    const source = await make('contacts', { name: 'Same', code__c: 'KEY-1' }, 2)
    const out = ok(await merge(survivor.id, source.id))
    expect(out).toMatchObject({ id: survivor.id, code__c: 'KEY-1', merge_conflicts: [] })
    expect((await row('contacts', survivor.id)).code__c).toBe('KEY-1')
    const tomb = await row('contacts', source.id)
    expect(tomb.code__c).toBe('KEY-1')
    expect(tomb.deleted_at).not.toBeNull()
    expect(survivor.lvl__c).toBe(DEFAULT_LEVEL)
    await satisfied()
  })
  it('both hold one: the survivor keeps its value, the conflict lists the source value, no index error', async () => {
    const survivor = await make('contacts', { name: 'Same', code__c: 'MINE' })
    const source = await make('contacts', { name: 'Same', code__c: 'THEIRS' }, 2)
    const out = ok(await merge(survivor.id, source.id))
    expect(out.code__c).toBe('MINE')
    expect(out.merge_conflicts).toEqual([{ field: 'code__c', source_value: 'THEIRS' }])
    expect((await row('contacts', source.id)).code__c).toBe('THEIRS')
    await satisfied()
  })
  it('through the rail: an approved proposal fills the survivor under the index', async () => {
    const survivor = await make('contacts', { name: 'Same' })
    const source = await make('contacts', { name: 'Same', code__c: 'KEY-RAIL' }, 2)
    await viaRail('contacts.merge', { id: survivor.id, source_id: source.id })
    expect((await row('contacts', survivor.id)).code__c).toBe('KEY-RAIL')
    expect((await row('contacts', source.id)).code__c).toBe('KEY-RAIL')
    await satisfied()
  })
  it('through the rail, both holding one: the survivor keeps its value', async () => {
    const survivor = await make('contacts', { name: 'Same', code__c: 'MINE' })
    const source = await make('contacts', { name: 'Same', code__c: 'THEIRS' }, 2)
    await viaRail('contacts.merge', { id: survivor.id, source_id: source.id })
    expect((await row('contacts', survivor.id)).code__c).toBe('MINE')
    await satisfied()
  })
})

describe('deals.move_stage', () => {
  const stageOf = async (dealId: string, name: string, kind = 'open') => {
    const deal = await row('deals', dealId)
    const stage = ok(
      await k.call(owner, 'POST', '/meta/v1/pipeline-stages', {
        pipeline_id: deal.pipeline_id,
        name,
        kind,
        position: 50,
      }),
      201,
    )
    return stage.id as string
  }
  it('moves a deal, twice, leaving the extension columns as stored', async () => {
    const deal = await make('deals', { name: 'D' })
    const second = await stageOf(deal.id, 'Second')
    const won = await stageOf(deal.id, 'Won', 'won')
    ok(await k.call(owner, 'POST', `${pathOf('deals')}/${deal.id}/move-stage`, { stage_id: second }))
    ok(await k.call(owner, 'POST', `${pathOf('deals')}/${deal.id}/move-stage`, { stage_id: won }))
    expectUntouched(await row('deals', deal.id), 'deals')
    await satisfied()
  })
  it('through the rail', async () => {
    const deal = await make('deals', { name: 'D' })
    const second = await stageOf(deal.id, 'Second')
    await viaRail('deals.move_stage', { id: deal.id, stage_id: second })
    expect((await row('deals', deal.id)).stage_id).toBe(second)
    await satisfied()
  })
})

describe('the delete cascades', () => {
  it('a company with linked contacts: the contacts unlink, the company tombstones, the extension columns stay as stored', async () => {
    const company = await make('companies', { name: 'Co' })
    const a = await make('contacts', { name: 'A', company_id: company.id, co__c: company.id }, 1)
    await make('contacts', { name: 'B', company_id: company.id }, 2)
    ok(await k.call(owner, 'DELETE', `${pathOf('companies')}/${company.id}`), 204)
    expect((await row('contacts', a.id)).company_id).toBeNull()
    expect((await row('companies', company.id)).deleted_at).not.toBeNull()
    // D21: the extension reference is kept as stored, with no ON DELETE action.
    expect((await row('contacts', a.id)).co__c).toBe(company.id)
    await satisfied()
  })
  it.each(['contacts', 'deals', 'tasks'] as const)(
    '%s: a delete tombstones the row and keeps the guards',
    async (r) => {
      const made = await make(r)
      ok(await k.call(owner, 'DELETE', `${pathOf(r)}/${made.id}`), 204)
      expect((await row(r, made.id)).deleted_at).not.toBeNull()
      await satisfied()
    },
  )
  it('a pipeline stage in use is refused, and nothing moves', async () => {
    const deal = await make('deals', { name: 'D' })
    const refused = await k.call(owner, 'DELETE', `/meta/v1/pipeline-stages/${deal.stage_id}`)
    expect([refused.status, refused.body.error.code]).toEqual([409, 'stage_in_use'])
    await satisfied()
  })
  it('through the rail: an approved company delete, a contact delete and a deal delete', async () => {
    const company = await make('companies', { name: 'Co' })
    const contact = await make('contacts', { name: 'C', company_id: company.id })
    const deal = await make('deals', { name: 'D' })
    await viaRail('companies.delete', { id: company.id })
    await viaRail('contacts.delete', { id: contact.id })
    await viaRail('deals.delete', { id: deal.id })
    for (const [r, id] of [
      ['companies', company.id],
      ['contacts', contact.id],
      ['deals', deal.id],
    ] as const)
      expect((await row(r, id)).deleted_at, r).not.toBeNull()
    await satisfied()
  })
})

describe('D21: a stale reference does not block writes (565.4)', () => {
  /** A contact whose `co__c` points at a company that is then soft-deleted. */
  const stale = async () => {
    const company = await make('companies', { name: 'Gone' })
    const contact = await make('contacts', { name: 'Holder', co__c: company.id })
    ok(await k.call(owner, 'DELETE', `${pathOf('companies')}/${company.id}`), 204)
    return { company: company.id as string, contact: contact.id as string }
  }
  it('a patch that does not name the field succeeds and leaves the value as stored', async () => {
    const { company, contact } = await stale()
    ok(await k.call(owner, 'PATCH', `${pathOf('contacts')}/${contact}`, { name: 'Renamed' }))
    const r = await row('contacts', contact)
    expect([r.name, r.co__c]).toEqual(['Renamed', company])
  })
  it('a patch that names the same value is 400 invalid_reference, nothing written', async () => {
    const { company, contact } = await stale()
    const res = await k.call(owner, 'PATCH', `${pathOf('contacts')}/${contact}`, { name: 'Nope', co__c: company })
    expect([res.status, res.body.error.code]).toEqual([400, 'invalid_reference'])
    expect((await row('contacts', contact)).name).toBe('Holder')
  })
  it('a patch that clears the field succeeds', async () => {
    const { contact } = await stale()
    ok(await k.call(owner, 'PATCH', `${pathOf('contacts')}/${contact}`, { co__c: null }))
    expect((await row('contacts', contact)).co__c).toBeNull()
  })
  it('deals.move_stage on a deal holding a soft-deleted contact succeeds', async () => {
    const contact = await make('contacts', { name: 'Gone' })
    const deal = await make('deals', { name: 'D', ct__c: contact.id })
    ok(await k.call(owner, 'DELETE', `${pathOf('contacts')}/${contact.id}`), 204)
    const d = await row('deals', deal.id)
    const stage = ok(
      await k.call(owner, 'POST', '/meta/v1/pipeline-stages', {
        pipeline_id: d.pipeline_id,
        name: 'Next',
        kind: 'open',
        position: 50,
      }),
      201,
    )
    ok(await k.call(owner, 'POST', `${pathOf('deals')}/${deal.id}/move-stage`, { stage_id: stage.id }))
    expect((await row('deals', deal.id)).ct__c).toBe(contact.id)
  })
  it('contacts.merge of a contact whose reference is stale succeeds, and the merged survivor keeps the value it holds', async () => {
    const { company, contact } = await stale()
    const survivor = await make('contacts', { name: 'Same' }, 2)
    ok(await k.call(owner, 'POST', `${pathOf('contacts')}/${survivor.id}/merge`, { source_id: contact }))
    expect((await row('contacts', survivor.id)).co__c).toBe(company)
  })
  it.each(['companies', 'deals', 'tasks'] as const)(
    '%s: a patch not naming the stale reference succeeds',
    async (r) => {
      const target = await make('contacts', { name: 'Gone' })
      const holder = await make(r, { [REF[r].column]: target.id })
      ok(await k.call(owner, 'DELETE', `${pathOf('contacts')}/${target.id}`), 204)
      const patch = r === 'tasks' ? { title: 'Renamed' } : { name: 'Renamed' }
      ok(await k.call(owner, 'PATCH', `${pathOf(r)}/${holder.id}`, patch))
      expect((await row(r, holder.id))[REF[r].column]).toBe(target.id)
      const again = await k.call(owner, 'PATCH', `${pathOf(r)}/${holder.id}`, { [REF[r].column]: target.id })
      expect([again.status, again.body.error.code]).toEqual([400, 'invalid_reference'])
    },
  )
})
