import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'

// [[AGT8]] D58 (#168): approve, reject and withdraw answer the same 404 for an existing request as for a missing id when the caller holds neither
// `action_requests:read` nor the target's authority at the command's level (and, for withdraw, is not the source). Every other caller keeps D46's order.
let k: ActionKit
let owner: Actor
let writer: Actor
let proposer: Actor
let blind: Actor
beforeAll(async () => {
  k = await openActionKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  owner = k.owner
  writer = await k.actor('writer', 'agent', ['tasks:read', 'tasks:write'])
  proposer = await k.actor('proposer', 'agent', ['tasks:read', 'tasks:request_approval', 'action_requests:read'])
  // Sees tasks, may propose them, can neither read the queue nor decide anything.
  blind = await k.actor('blind', 'agent', ['tasks:read', 'contacts:request_approval'])
})
const AR = '/api/v1/action-requests'
const MISSING = '0190b2c4-0000-7000-8000-00000000dead'
const propose = async (who = proposer) => (await k.call(who, 'POST', AR, { operation: 'tasks.create', arguments: { title: 't' }, reason: 'r' })).body.id as string
const bytes = (r: { status: number; body: unknown }) => JSON.stringify([r.status, r.body])
const COMMANDS = ['approve', 'reject', 'withdraw'] as const

describe('a caller with no read of the queue and no authority learns nothing about an id', () => {
  it.each(COMMANDS)('%s: an existing pending request and a missing id answer byte-identical 404s', async (command) => {
    const id = await propose()
    const existing = await k.call(blind, 'POST', `${AR}/${id}/${command}`)
    const missing = await k.call(blind, 'POST', `${AR}/${MISSING}/${command}`)
    expect(existing.status).toBe(404)
    expect(existing.body.error.code).toBe('not_found')
    expect(bytes(existing)).toBe(bytes(missing))
    expect((await k.rows('action_requests', 'id = ?', id))[0]!.status).toBe('pending')
  })

  it.each(COMMANDS)('%s: neither the status nor the expiry of a decided request leaks', async (command) => {
    const rejected = await propose()
    const expired = await propose()
    expect((await k.call(owner, 'POST', `${AR}/${rejected}/reject`)).status).toBe(200)
    k.setNow(new Date(k.now().getTime() + 8 * 86_400_000))
    const missing = bytes(await k.call(blind, 'POST', `${AR}/${MISSING}/${command}`))
    expect(bytes(await k.call(blind, 'POST', `${AR}/${rejected}/${command}`))).toBe(missing)
    expect(bytes(await k.call(blind, 'POST', `${AR}/${expired}/${command}`))).toBe(missing)
    k.setNow(new Date('2026-11-06T10:00:00.000Z'))
  })
})

describe('every other caller keeps D46\'s order', () => {
  it('a caller with action_requests:read but no authority is told what is wrong: 409 for a decided request, 403 for a pending one', async () => {
    const reader = await k.actor('reader', 'agent', ['action_requests:read', 'tasks:read'])
    const id = await propose()
    expect(await k.call(reader, 'POST', `${AR}/${id}/approve`)).toMatchObject({ status: 403, body: { error: { code: 'insufficient_scope' } } })
    expect(await k.call(reader, 'POST', `${AR}/${id}/reject`)).toMatchObject({ status: 403, body: { error: { code: 'insufficient_scope' } } })
    expect(await k.call(reader, 'POST', `${AR}/${id}/withdraw`)).toMatchObject({ status: 403, body: { error: { code: 'not_request_source' } } })
    expect((await k.call(owner, 'POST', `${AR}/${id}/reject`)).status).toBe(200)
    expect(await k.call(reader, 'POST', `${AR}/${id}/approve`)).toMatchObject({ status: 409, body: { error: { code: 'action_request_not_pending' } } })
    expect((await k.call(reader, 'POST', `${AR}/${MISSING}/approve`)).status).toBe(404)
  })

  it('a caller with the target\'s write but no queue read keeps 409 not pending and 409 expired', async () => {
    const id = await propose()
    const done = await propose()
    expect((await k.call(owner, 'POST', `${AR}/${done}/reject`)).status).toBe(200)
    expect(await k.call(writer, 'POST', `${AR}/${done}/approve`)).toMatchObject({ status: 409, body: { error: { code: 'action_request_not_pending' } } })
    expect(await k.call(writer, 'POST', `${AR}/${done}/reject`)).toMatchObject({ status: 409, body: { error: { code: 'action_request_not_pending' } } })
    k.setNow(new Date(k.now().getTime() + 8 * 86_400_000))
    expect(await k.call(writer, 'POST', `${AR}/${id}/approve`)).toMatchObject({ status: 409, body: { error: { code: 'action_request_expired' } } })
    k.setNow(new Date('2026-11-06T10:00:00.000Z'))
  })

  it('withdraw: the source with no queue read still gets 409 once it is decided, and a non-source proposer 403 not_request_source', async () => {
    const lone = await k.actor('lone', 'agent', ['tasks:request_approval'])
    const id = await propose(lone)
    const other = await k.actor('other', 'agent', ['tasks:request_approval'])
    expect(await k.call(other, 'POST', `${AR}/${id}/withdraw`)).toMatchObject({ status: 403, body: { error: { code: 'not_request_source' } } })
    expect((await k.call(owner, 'POST', `${AR}/${id}/reject`)).status).toBe(200)
    expect(await k.call(lone, 'POST', `${AR}/${id}/withdraw`)).toMatchObject({ status: 409, body: { error: { code: 'action_request_not_pending' } } })
    // A source that has lost its authority over the target is hidden nothing: it is the source.
    const stripped = k.as(lone, ['contacts:read'])
    const id2 = await propose(lone)
    expect((await k.call(stripped, 'POST', `${AR}/${id2}/withdraw`)).status).toBe(403)
  })
})
