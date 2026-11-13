import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { eligible, FIXTURES, directCall, prereq } from '../test/action-fixtures.js'
import { memoryObjectStore } from '../objects/store.js'
import { describeSendBody } from '../messaging/send-body.js'
import { openActionKit, type ActionKit } from '../test/action-kit.js'

// [[AGT8]] Required validation 1: the permission matrix, generated from the manifest. For every proposal-eligible operation and for read-only,
// proposal-only, write and no scopes: the direct write, the action request, the approval. A newly eligible operation fails the first case until
// it has a fixture (`test/action-fixtures.ts`).
const registry = createVibaseRegistry()
const ops = eligible(registry)
let k: ActionKit
beforeAll(async () => {
  k = await openActionKit({objects:memoryObjectStore()})
})
afterAll(() => k.close())
beforeEach(() => k.reset())

it('every eligible operation has a fixture, and every fixture an eligible operation', () => {
  expect(Object.keys(FIXTURES).sort()).toEqual(ops.map((o) => o.name).sort())
})

describe.each(ops.map((o) => [o.name, o] as const))('%s', (name, op) => {
  const r = op.scope!.resource
  const fx = FIXTURES[name]!
  const reads = fx.reads ?? []
  const variants = {
    none: [] as string[],
    read: [`${r}:read`, ...reads],
    proposal: [`${r}:request_approval`, ...reads],
    write: [`${r}:write`, ...reads],
  }

  it('direct write, request and approval follow the scopes', async () => {
    const o = prereq(k)
    let n = 0
    const next = () => fx.args(o, ++n)
    for (const [variant, scopes] of Object.entries(variants) as Array<[keyof typeof variants, string[]]>) {
      const who = await k.actor(`${variant}`, 'agent', scopes)
      const reviewerScopes = [...scopes, 'action_requests:read']

      // The direct write: only write runs it.
      const direct = directCall(op, await next())
      const d = await k.call(who, direct.method, direct.path, direct.body)
      if (variant === 'write') expect(d.status, `${name} direct as write: ${JSON.stringify(d.body)}`).toBeLessThan(300)
      else {
        expect([d.status, d.body.error.code], `${name} direct as ${variant}`).toEqual([403, 'insufficient_scope'])
        expect(d.body.error.message).toContain(`requires ${r}:write`)
        // The hint only for the one holder of request_approval that can follow it.
        expect(d.body.error.message.includes(`action_requests.create with operation=${name}`), `${name} hint as ${variant}`).toBe(variant === 'proposal')
      }

      // The request: request_approval (write contains it).
      const args = await next()
      const before = (await k.events()).length
      const c = await k.call(who, 'POST', '/api/v1/action-requests', { operation: name, arguments: args, reason: 'matrix' })
      if (variant === 'none' || variant === 'read') {
        expect([c.status, c.body.error.code], `${name} create as ${variant}`).toEqual([403, 'insufficient_scope'])
        expect(c.body.error.message).toContain(`${r}:request_approval`)
        continue
      }
      expect(c.status, `${name} create as ${variant}: ${JSON.stringify(c.body)}`).toBe(201)
      expect(c.body).toMatchObject({ operation: name, status: 'pending', arguments: name==='messages.send'?{...args,body:await describeSendBody(args.body as string)}:args, created_by: who.id })
      // Nothing but the request's own event was written: the target is untouched.
      expect((await k.events()).slice(before).map((e) => e.type)).toEqual(['action_request.created'])

      // The approval: write on the target, never request_approval, never read.
      // The reviewer can read the queue, so D46's order tells it what is wrong (a caller who cannot is told 404, D58: hidden-existence.rest.integration.test.ts).
      const a = await k.call(k.as(who, reviewerScopes), 'POST', `/api/v1/action-requests/${c.body.id}/approve`)
      if (variant === 'proposal') {
        expect([a.status, a.body.error.code], `${name} approve as proposal`).toEqual([403, 'insufficient_scope'])
        expect(a.body.error.message).toContain(`${r}:write`)
        expect((await k.rows('action_requests', 'id = ?', c.body.id))[0]!.status).toBe('pending')
      } else {
        expect(a.status, `${name} approve as write: ${JSON.stringify(a.body)}`).toBe(200)
        expect(a.body).toMatchObject({ status: op.execution?'approved':'executed', decided_by: who.id })
      }
    }
    // Approve with no scopes and with read only is refused too (a request made by the owner).
    for (const variant of ['none', 'read'] as const) {
      const who = await k.actor(`${variant}`, 'agent', variants[variant])
      const c = await k.call(k.owner, 'POST', '/api/v1/action-requests', { operation: name, arguments: await next(), reason: 'matrix' })
      expect(c.status).toBe(201)
      const a = await k.call(k.as(who, [...variants[variant], 'action_requests:read']), 'POST', `/api/v1/action-requests/${c.body.id}/approve`)
      expect([a.status, a.body.error.code], `${name} approve as ${variant}`).toEqual([403, 'insufficient_scope'])
      // Without the queue read it is the 404 of a missing id (D58).
      const blind = await k.call(who, 'POST', `/api/v1/action-requests/${c.body.id}/approve`)
      expect([blind.status, blind.body.error.code], `${name} approve as ${variant}, no queue read`).toEqual([404, 'not_found'])
    }
  })
})

describe('what is not an eligible operation is refused', () => {
  it('an unknown name and an ineligible one are 400 operation_not_proposable, the ineligible one with its reason', async () => {
    const unknown = await k.call(k.owner, 'POST', '/api/v1/action-requests', { operation: 'tasks.nothing', arguments: {}, reason: 'x' })
    expect([unknown.status, unknown.body.error.code]).toEqual([400, 'operation_not_proposable'])
    for (const [name, reason] of [
      ['agents.create', 'access administration'],
      ['api_keys.create', 'credentials'],
      ['connections.authorize', 'consent screen'],
      ['tasks.list', 'read-only'],
      ['action_requests.approve', 'never proposed'],
    ] as const) {
      const r = await k.call(k.owner, 'POST', '/api/v1/action-requests', { operation: name, arguments: {}, reason: 'x' })
      expect([r.status, r.body.error.code], name).toEqual([400, 'operation_not_proposable'])
      expect(r.body.error.message, name).toContain(reason)
    }
  })

  it('a missing target record is 404 as a direct call would say, and writes nothing', async () => {
    const count = Number((await k.rows('action_requests')).length)
    const r = await k.call(k.owner, 'POST', '/api/v1/action-requests', { operation: 'tasks.update', arguments: { id: '0190b2c4-0000-7000-8000-00000000dead', title: 'x' }, reason: 'x' })
    expect([r.status, r.body.error.code]).toEqual([404, 'not_found'])
    expect((await k.rows('action_requests')).length).toBe(count)
    expect(await k.events()).toEqual([])
  })
})
