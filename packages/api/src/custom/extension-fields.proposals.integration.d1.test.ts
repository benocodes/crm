import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ActionKit, Actor } from '../test/action-kit.js'
import { RESOURCES, ONE_OF_EACH, baseBody, every, openExtendedKit, pathOf, type Resource } from '../test/extension-kit.js'

// [[CORE559]] P1, P7: a proposal of create or update with extension fields is validated against the extended schema, and on approval executes through the registry and stores the value (and its event carries it).
let k: ActionKit
let owner: Actor
let proposer: Actor
beforeAll(async () => {
  k = await openExtendedKit(every(ONE_OF_EACH))
})
afterAll(() => k.close())
beforeEach(async () => {
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

describe.each(RESOURCES)('%s', (r: Resource) => {
  it('a proposed update with an extension field is approved, executed and stored; a proposed create too', async () => {
    const made = await k.call(owner, 'POST', pathOf(r), await baseBody(k, owner, r))
    const proposed = await k.call(proposer, 'POST', AR, {
      operation: `${r}.update`,
      arguments: { id: made.body.id, tier__c: 'gold', seats__c: 7 },
      reason: 'because',
    })
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201)
    const approved = await k.call(owner, 'POST', `${AR}/${proposed.body.id}/approve`)
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body.status).toBe('executed')
    expect((await k.call(owner, 'GET', `${pathOf(r)}/${made.body.id}`)).body).toMatchObject({ tier__c: 'gold', seats__c: 7 })
    const ev = (await k.events()).filter((x) => x.resource_id === made.body.id && x.type.endsWith('.updated'))
    expect(ev[0]!.after).toMatchObject({ tier__c: 'gold', seats__c: 7 })

    const create = await k.call(proposer, 'POST', AR, {
      operation: `${r}.create`,
      arguments: { ...(await baseBody(k, owner, r, 2)), note__c: 'proposed' },
      reason: 'because',
    })
    expect(create.status, JSON.stringify(create.body)).toBe(201)
    expect((await k.call(owner, 'POST', `${AR}/${create.body.id}/approve`)).status).toBe(200)
    expect((await k.rows(r, `"note__c" = 'proposed'`)).length).toBe(1)
  })

  it('a proposal whose extension value is outside the declaration is refused at proposal time', async () => {
    const made = await k.call(owner, 'POST', pathOf(r), await baseBody(k, owner, r))
    const bad = await k.call(proposer, 'POST', AR, {
      operation: `${r}.update`,
      arguments: { id: made.body.id, tier__c: 'bronze' },
      reason: 'because',
    })
    expect(bad.status).toBe(400)
  })
})
