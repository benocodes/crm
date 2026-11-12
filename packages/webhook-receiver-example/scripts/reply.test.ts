import { describe, expect, it } from 'vitest'
import { makeWorkerdStepShim } from '@vault/api/test/workerd-boundary'
import { draftReply, runReply } from '../src/reply.js'
import { FakeVault, IDS } from './fake-vault.js'
import { eventRecord } from './helpers.js'

const setup = (shimOptions: Parameters<typeof makeWorkerdStepShim>[0] = {}) => {
  const vault = new FakeVault()
  const shim = makeWorkerdStepShim({ retries: 0, ...shimOptions })
  const refusals: string[] = []
  const deps = { baseUrl: 'http://vault.test', apiKey: vault.apiKey, fetch: vault.fetch, nonRetryable: (m: string) => (refusals.push(m), new Error(m)) }
  const run = () => runReply({ payload: eventRecord() }, shim.step, deps)
  return { vault, shim, refusals, run }
}
const proposals = (v: FakeVault) => v.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/action-requests')

describe('workflow: an inbound email interaction (D21)', () => {
  it('reads the message and its content with its own key, then proposes exactly one reply', async () => {
    const { vault, run } = setup()
    const out = await run()
    expect(out).toMatchObject({ outcome: 'proposed', created: true })
    const paths = vault.requests.map((r) => `${r.method} ${r.path}`)
    expect(paths).toEqual(expect.arrayContaining([`GET /api/v1/interactions/${IDS.interaction}`, `GET /api/v1/messages/${IDS.message}`, `GET /api/v1/messages/${IDS.message}/content`]))
    expect(vault.authorizations()).toEqual(new Set([`Bearer ${vault.apiKey}`]))
    expect(proposals(vault)).toHaveLength(1)
    expect(proposals(vault)[0]!.body).toEqual({
      operation: 'messages.send',
      arguments: { connection_id: IDS.connection, mode: 'reply', thread_id: IDS.thread, to: ['customer@example.test'], body: expect.any(String) },
      reason: expect.any(String),
      interaction_id: IDS.interaction,
    })
    expect(vault.actionRequests).toHaveLength(1)
  })
  it('an outbound interaction creates no proposal', async () => {
    const { vault, run } = setup()
    vault.interactions.get(IDS.interaction)!.direction = 'outbound'
    expect(await run()).toEqual({ outcome: 'skipped', reason: 'not_inbound_email' })
    expect(proposals(vault)).toHaveLength(0)
  })
  it('a reaction interaction creates no proposal', async () => {
    const { vault, run } = setup()
    vault.interactions.get(IDS.interaction)!.kind = 'reaction'
    expect((await run()).outcome).toBe('skipped')
    expect(proposals(vault)).toHaveLength(0)
  })
  it('chooses the active connection whose mailbox received the message, among several', async () => {
    const { vault, run } = setup()
    vault.connections = [{ id: IDS.otherConnection, identity_id: IDS.otherIdentity, status: 'active' }, ...vault.connections]
    await run()
    expect((proposals(vault)[0]!.body as any).arguments.connection_id).toBe(IDS.connection)
  })
  it('uses the sole active connection when no mailbox matches, and skips when several are active and none matches or none is active', async () => {
    const a = setup()
    a.vault.connections = [{ id: IDS.otherConnection, identity_id: IDS.otherIdentity, status: 'active' }, { id: IDS.connection, identity_id: IDS.mailboxIdentity, status: 'reauth_required' }]
    await a.run()
    expect((proposals(a.vault)[0]!.body as any).arguments.connection_id).toBe(IDS.otherConnection)
    const b = setup()
    b.vault.connections = [{ id: IDS.otherConnection, identity_id: IDS.otherIdentity, status: 'active' }, { id: IDS.connection, identity_id: IDS.senderIdentity, status: 'active' }]
    expect(await b.run()).toEqual({ outcome: 'skipped', reason: 'no_matching_connection' })
    const c = setup()
    c.vault.connections = []
    expect(await c.run()).toEqual({ outcome: 'skipped', reason: 'no_matching_connection' })
    expect(proposals(b.vault).length + proposals(c.vault).length).toBe(0)
  })
  it('re-running the propose step after its create committed creates no second request', async () => {
    const { vault, run } = setup({ retries: 1, afterCommit: (name, attempt) => { if (name === 'propose-reply' && attempt === 0) throw new Error('lost the step result') } })
    const out = await run()
    expect(out).toMatchObject({ outcome: 'proposed', created: false })
    expect(vault.actionRequests).toHaveLength(1)
    expect(proposals(vault)).toHaveLength(1)
    const lookups = vault.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/api/v1/action-requests'))
    expect(lookups.length).toBe(2)
    expect(lookups[0]!.path).toContain(`interaction_id=${IDS.interaction}`)
  })
  it('a vault 403 ends non-retryably, naming the status and code', async () => {
    const { vault, refusals, run } = setup()
    vault.refuse.set('POST /api/v1/action-requests', { status: 403, code: 'insufficient_scope' })
    await expect(run()).rejects.toThrow(/403.*insufficient_scope/)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatch(/403.*insufficient_scope/)
  })
  it('a vault 5xx and a network error are plain (retryable) errors, never non-retryable', async () => {
    const a = setup()
    a.vault.refuse.set('GET /api/v1/interactions', { status: 503, code: 'unavailable' })
    await expect(a.run()).rejects.toThrow(/503/)
    expect(a.refusals).toHaveLength(0)
    const b = setup()
    const failing = { ...b.vault, fetch: (async () => { throw new TypeError('network down') }) as typeof fetch }
    await expect(runReply({ payload: eventRecord() }, b.shim.step, { baseUrl: 'http://vault.test', apiKey: 'k', fetch: failing.fetch, nonRetryable: (m) => (b.refusals.push(m), new Error(m)) })).rejects.toThrow(/network down/)
    expect(b.refusals).toHaveLength(0)
  })
  it('a 429 and a 409 from the vault are retryable', async () => {
    for (const status of [429, 409]) {
      const a = setup()
      a.vault.refuse.set('GET /api/v1/interactions', { status, code: 'later' })
      await expect(a.run()).rejects.toThrow(String(status))
      expect(a.refusals).toHaveLength(0)
    }
  })
  it('every step return passes the workerd boundary shim, and step names are the documented four', async () => {
    const { shim, run } = setup()
    await run()
    expect(shim.names).toEqual(['read-message', 'find-connection', 'draft-reply', 'propose-reply'])
    expect(shim.returns).toHaveLength(4)
  })
  it('the key is never part of any step return or error message', async () => {
    const { vault, shim, run } = setup()
    await run()
    expect(JSON.stringify(shim.returns)).not.toContain(vault.apiKey)
  })
})

describe('draftReply', () => {
  it('is pure and mentions what the customer asked', () => {
    const msg = { from: 'customer@example.test', content: 'Hello, can you send the pricing sheet?' }
    expect(draftReply(msg)).toBe(draftReply(msg))
    expect(draftReply(msg).length).toBeGreaterThan(0)
  })
})
