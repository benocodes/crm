import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ActionKit, Actor } from '../test/action-kit.js'
import {
  RESOURCES,
  EVENT_OF,
  baseBody,
  every,
  openExtendedKit,
  pathOf,
  resetKit,
  type Resource,
} from '../test/extension-kit.js'

// [[CORE559]] P2, P7 (D23): every event of the four tables carries the row's `__c` fields in its record, whichever path emits it: generic CRUD, `identities.resolve`, a delete cascade, `deals.move_stage`, merge's events. No system
// path writes a `__c` column. (The form submission path is in extension-fields.forms.integration.d1.test.ts.)
const FIELDS = {
  note__c: { kind: 'text' },
  tier__c: { kind: 'enum', values: ['gold', 'silver'] },
  lvl__c: { kind: 'enum', values: ['a', 'b'], required: true, default: 'a' },
  vip__c: { kind: 'boolean' },
  seats__c: { kind: 'integer' },
} as const
let k: ActionKit
let owner: Actor
beforeAll(async () => {
  k = await openExtendedKit(every(FIELDS as never))
})
afterAll(() => k.close())
beforeEach(async () => {
  await resetKit(k)
  owner = k.owner
})
const carried = { note__c: 'n', tier__c: 'gold', lvl__c: 'b', vip__c: true, seats__c: 3 }

describe.each(RESOURCES)('generic CRUD of %s', (r: Resource) => {
  it('created, updated and deleted events carry every extension field, typed', async () => {
    const made = await k.call(owner, 'POST', pathOf(r), { ...(await baseBody(k, owner, r)), ...carried })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    await k.call(owner, 'PATCH', `${pathOf(r)}/${made.body.id}`, { seats__c: 4, vip__c: false })
    await k.call(owner, 'DELETE', `${pathOf(r)}/${made.body.id}`)
    const ev = EVENT_OF[r]
    const [created] = await k.events(`${ev}.created`)
    expect(created!.after).toMatchObject(carried)
    const [updated] = await k.events(`${ev}.updated`)
    expect(updated!.before).toMatchObject(carried)
    expect(updated!.after).toMatchObject({ ...carried, seats__c: 4, vip__c: false })
    const [deleted] = await k.events(`${ev}.deleted`)
    expect(deleted!.before).toMatchObject({ ...carried, seats__c: 4, vip__c: false })
    expect(deleted!.after).toBeNull()
  })
})

describe('the hand-written paths', () => {
  const resolve = (value: string, name?: string) =>
    k.call(owner, 'POST', '/api/v1/identities/resolve', {
      identities: [{ kind: 'email', value, ...(name ? { name } : {}) }],
    })

  it('identities.resolve: the contact it creates is in the response with the extension fields, and its event carries the stored default', async () => {
    const res = await resolve('new@x.test', 'New')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data[0].contact).toMatchObject({ name: 'New', note__c: null, lvl__c: 'a', seats__c: null })
    const [created] = await k.events('contact.created')
    expect(created!.after).toMatchObject({ note__c: null, lvl__c: 'a', vip__c: null, seats__c: null })
    // the system writer set no extension column
    const row = (await k.rows('contacts'))[0]!
    expect([row.note__c, row.tier__c, row.seats__c]).toEqual([null, null, null])
  })

  it('a delete cascade: deleting a company unlinks its contacts, whose contact.updated events carry their fields; the parent event too', async () => {
    const co = (await k.call(owner, 'POST', '/api/v1/companies', { name: 'Acme', ...carried })).body.id
    const c = await k.call(owner, 'POST', '/api/v1/contacts', { name: 'Jo', company_id: co, ...carried, seats__c: 9 })
    expect(c.status, JSON.stringify(c.body)).toBe(201)
    expect((await k.call(owner, 'DELETE', `/api/v1/companies/${co}`)).status).toBe(204)
    const unlinked = (await k.events('contact.updated')).find((e) => e.resource_id === c.body.id)!
    expect(unlinked.before).toMatchObject({ company_id: co, ...carried, seats__c: 9 })
    expect(unlinked.after).toMatchObject({ company_id: null, ...carried, seats__c: 9 })
    const [gone] = await k.events('company.deleted')
    expect(gone!.before).toMatchObject(carried)
  })

  it('deleting a contact, a task and a deal: the before of the delete event carries the fields', async () => {
    const contact = (await k.call(owner, 'POST', '/api/v1/contacts', { name: 'Jo', ...carried })).body.id
    const task = (await k.call(owner, 'POST', '/api/v1/tasks', { title: 'T', ...carried })).body.id
    const deal = (await k.call(owner, 'POST', '/api/v1/deals', { ...(await baseBody(k, owner, 'deals')), ...carried }))
      .body.id
    for (const [path, id] of [
      ['contacts', contact],
      ['tasks', task],
      ['deals', deal],
    ] as const) {
      expect((await k.call(owner, 'DELETE', `/api/v1/${path}/${id}`)).status, path).toBe(204)
    }
    for (const type of ['contact.deleted', 'task.deleted', 'deal.deleted'])
      expect((await k.events(type))[0]!.before, type).toMatchObject(carried)
  })

  it('deals.move_stage: deal.stage_changed carries the fields before and after, and the response too', async () => {
    const first = await baseBody(k, owner, 'deals')
    const stage2 = (
      await k.call(owner, 'POST', '/meta/v1/pipeline-stages', {
        pipeline_id: (await k.rows('pipeline_stages'))[0]!.pipeline_id,
        name: 'Next',
        kind: 'open',
        position: 20,
      })
    ).body.id
    const deal = await k.call(owner, 'POST', '/api/v1/deals', { ...first, ...carried })
    const moved = await k.call(owner, 'POST', `/api/v1/deals/${deal.body.id}/move-stage`, { stage_id: stage2 })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(moved.body).toMatchObject({ ...carried, stage_id: stage2 })
    const [ev] = await k.events('deal.stage_changed')
    expect(ev!.before).toMatchObject(carried)
    expect(ev!.after).toMatchObject({ ...carried, stage_id: stage2 })
  })

  it('contacts.merge: the fill and merged events carry the fields; merge writes no extension column', async () => {
    const survivor = (
      await k.call(owner, 'POST', '/api/v1/contacts', { ...{ name: null }, note__c: null, seats__c: 1 })
    ).body
    const source = (
      await k.call(owner, 'POST', '/api/v1/contacts', {
        name: 'Source',
        note__c: 'from source',
        tier__c: 'gold',
        seats__c: 2,
      })
    ).body
    const merged = await k.call(owner, 'POST', `/api/v1/contacts/${survivor.id}/merge`, { source_id: source.id })
    expect(merged.status, JSON.stringify(merged.body)).toBe(200)
    // the core field filled, the extension fields were not (D13 is U3)
    expect(merged.body).toMatchObject({ name: 'Source', note__c: null, tier__c: null, seats__c: 1 })
    const fill = (await k.events('contact.updated')).find((e) => e.resource_id === survivor.id)!
    expect(fill.before).toMatchObject({ name: null, note__c: null, seats__c: 1, lvl__c: 'a' })
    expect(fill.after).toMatchObject({ name: 'Source', note__c: null, seats__c: 1, lvl__c: 'a' })
    const [tomb] = await k.events('contact.merged')
    expect(tomb!.before).toMatchObject({ note__c: 'from source', tier__c: 'gold', seats__c: 2 })
    expect(tomb!.after).toMatchObject({
      note__c: 'from source',
      tier__c: 'gold',
      seats__c: 2,
      merged_into_id: survivor.id,
    })
    const row = (await k.rows('contacts')).find((x) => x.id === survivor.id)!
    expect([row.note__c, row.tier__c, row.seats__c]).toEqual([null, null, 1])
  })
})
