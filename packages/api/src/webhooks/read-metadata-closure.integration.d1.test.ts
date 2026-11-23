import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ok, openSenderKit, type SenderKit } from '../test/sender-kit.js'
import { agentScopeSet } from './crm-reads.js'
import { checkEventTypes } from './operations.js'

// [[API518]] group 4 (D3, P2): webhook code closes an agent's STORED scopes against the registry's declared scopes. Nothing declares a read_metadata scope yet, so the seam
// declares `tasks:read_metadata` on the kit's registry and makes `task.*` events readable at it (the optional `action` of an event-type declaration, which only a test sets).
let s: SenderKit
beforeAll(async () => {
  s = await openSenderKit()
  const registry = s.k.registry
  const declared = registry.declaredScopes.bind(registry)
  registry.declaredScopes = () => [...declared(), 'tasks:read_metadata'].sort()
  registry.registerEventType('task', { scope: 'tasks', action: 'read_metadata' })
})
afterAll(() => s.close())
beforeEach(() => s.reset())

const WITH_READ = ['events:read', 'tasks:read']
const WITH_META = ['events:read', 'tasks:read_metadata']
const NEITHER = ['events:read']
const storedScopes = async (agent: string) =>
  (await s.k.all('select scopes from agents where id = ?', agent))[0]!.scopes as string

describe('agentScopeSet and the filters (D3, P2)', () => {
  const registry = () => s.k.registry
  it('closes x:read to x:read_metadata only where declared, and write to request_approval', () => {
    const set = agentScopeSet(registry(), ['tasks:read', 'contacts:read', 'tasks:write'])
    expect(set.has({ resource: 'tasks', action: 'read_metadata' })).toBe(true)
    expect(set.has({ resource: 'contacts', action: 'read_metadata' })).toBe(false)
    expect(set.has({ resource: 'tasks', action: 'request_approval' })).toBe(true)
  })
  it('a stored x:read_metadata survives the filter, and a malformed stored scope never throws', () => {
    const set = agentScopeSet(registry(), ['tasks:read_metadata', 'tasks:bogus', 'nonsense', ''])
    expect(set.toStrings()).toEqual(['tasks:read_metadata'])
  })
  it('crm-reads keeps a stored read_metadata scope on the agent facts (its filter)', async () => {
    const agent = await s.k.seedAgent(WITH_META)
    const { readAgent } = await import('./crm-reads.js')
    const { execute } = await import('@vibase/storage')
    const facts = (
      await execute(
        s.k.e.binding,
        { kind: 'internal', organizationId: s.k.e.organizationId },
        readAgent(s.k.e.organizationId, agent),
      )
    ).value
    expect(facts?.scopes).toEqual(WITH_META)
  })
  it('webhooks/operations: an agent stored at read_metadata alone passes the event-type check; one with neither fails', () => {
    expect(() => checkEventTypes(registry(), { id: 'a', scopes: WITH_META }, ['task.created'])).not.toThrow()
    expect(() => checkEventTypes(registry(), { id: 'a', scopes: WITH_READ }, ['task.created'])).not.toThrow()
    expect(() => checkEventTypes(registry(), { id: 'a', scopes: NEITHER }, ['task.created'])).toThrow(
      /event_type_not_readable|not readable|cannot/i,
    )
  })
})

describe('dispatch (D3, P2)', () => {
  it('an agent stored with x:read and one with x:read_metadata alone are eligible and get a row; an agent with neither gets none; stored scopes are untouched', async () => {
    const a = await s.subscribe({ scopes: WITH_READ })
    const b = await s.subscribe({ scopes: WITH_META })
    const c = await s.subscribe({ scopes: WITH_META })
    await s.k.grant(c.agent, NEITHER)
    const before = [await storedScopes(a.agent), await storedScopes(b.agent), await storedScopes(c.agent)]
    const event = await s.k.task('closed')
    await s.k.dispatch()
    expect((await s.k.deliveries(a.sub.id)).map((r) => r.event_id)).toEqual([event])
    expect((await s.k.deliveries(b.sub.id)).map((r) => r.event_id)).toEqual([event])
    expect(await s.k.deliveries(c.sub.id)).toEqual([])
    expect([await storedScopes(a.agent), await storedScopes(b.agent), await storedScopes(c.agent)]).toEqual(before)
    expect(before[0]).toBe(JSON.stringify(WITH_READ))
    expect(before[1]).toBe(JSON.stringify(WITH_META))
  })
})

describe('sender (D3, P2)', () => {
  it('delivers the event to x:read and x:read_metadata-alone agents, cancels an agent with neither, and leaves the stored scopes byte-identical', async () => {
    const a = await s.subscribe({ scopes: WITH_READ })
    const b = await s.subscribe({ scopes: WITH_META })
    const c = await s.subscribe({ scopes: WITH_META })
    const event = await s.k.task('send me')
    await s.k.dispatch()
    await s.k.grant(c.agent, NEITHER)
    const before = [await storedScopes(a.agent), await storedScopes(b.agent), await storedScopes(c.agent)]
    s.handler = () => ok(200)
    const summary = await s.send()
    expect(summary).toMatchObject({ sent: 2, cancelled: 1 })
    const rowOf = async (sub: string) =>
      (await s.k.all('select * from webhook_deliveries where subscription_id = ?', sub))[0]!
    expect(await rowOf(a.sub.id)).toMatchObject({ event_id: event, status: 'delivered' })
    expect(await rowOf(b.sub.id)).toMatchObject({ event_id: event, status: 'delivered' })
    expect(await rowOf(c.sub.id)).toMatchObject({ status: 'cancelled', last_error: 'cancelled_scope' })
    expect(s.calls).toHaveLength(2)
    expect([await storedScopes(a.agent), await storedScopes(b.agent), await storedScopes(c.agent)]).toEqual(before)
  })
})
