import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openEngines, type Engine } from '../test/engines.js'
import { foreignTenant, identityKit, type IdentityKit } from '../test/identity-kit.js'
import { ensureOwnIdentity, resolveOperation, type ResolveEntry } from './resolve.js'

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('identities.resolve and ensureOwnIdentity on %s', (name) => {
  let e: Engine
  let k: IdentityKit
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    k = identityKit(e)
  })
  const resolve = (entries: ResolveEntry[], opts?: { as?: 'agent' }) => k.run((env) => resolveOperation(env, entries), opts)
  const email = (value: string, extra: Partial<ResolveEntry> = {}): ResolveEntry => ({ kind: 'email', value, ...extra })

  describe('resolve', () => {
    it('creates a contact and an identity for a new address, normalised, with the name', async () => {
      const [r] = await resolve([email(' Ori@Example.com ', { name: 'Ori' })])
      expect(r).toMatchObject({ created: true, identity: { kind: 'email', value: 'ori@example.com', own: false }, contact: { name: 'Ori' } })
      expect(r!.identity.contact_id).toBe(r!.contact!.id)
      const ev = await k.events()
      expect(ev.map((x) => x.type)).toEqual(['contact.created', 'identity.created'])
      expect(ev[0]).toMatchObject({ actor_id: e.userId, before: null, after: r!.contact })
      expect(ev[1]).toMatchObject({ before: null, after: r!.identity })
    })

    it('a new address without a name gets a nameless contact', async () => {
      const [r] = await resolve([email('a@example.com')])
      expect(r!.contact!.name).toBeNull()
    })

    it('an existing address returns its identity and contact, never renames, and writes nothing', async () => {
      const [first] = await resolve([email('a@example.com', { name: 'First' })])
      const mark = (await e.rows('events')).length
      const [again] = await resolve([email('A@Example.com', { name: 'Second' })])
      expect(again).toMatchObject({ created: false, identity: { id: first!.identity.id }, contact: { id: first!.contact!.id, name: 'First' } })
      expect(await e.rows('events')).toHaveLength(mark)
    })

    it('an own identity resolves to contact null', async () => {
      const own = await k.identity({ kind: 'email', value: 'me@us.com', own: true })
      const [r] = await resolve([email('me@us.com')])
      expect(r).toMatchObject({ created: false, contact: null, identity: { id: own.id, own: true } })
    })

    it('a mixed batch answers in input order', async () => {
      const [known] = await resolve([email('known@example.com', { name: 'Known' })])
      const out = await resolve([email('new1@example.com'), email('known@example.com'), { kind: 'phone', value: '+44 20 7946 0958' }])
      expect(out.map((r) => r.created)).toEqual([true, false, true])
      expect(out.map((r) => r.identity.value)).toEqual(['new1@example.com', 'known@example.com', '+442079460958'])
      expect(out[1]!.identity.id).toBe(known!.identity.id)
    })

    it('an address repeated in a batch is one contact and one identity, created only on its first occurrence', async () => {
      const out = await resolve([email('dup@example.com', { name: 'First' }), email('DUP@example.com', { name: 'Second' })])
      expect(out.map((r) => r.created)).toEqual([true, false])
      expect(out[1]!.identity.id).toBe(out[0]!.identity.id)
      expect(out[0]!.contact!.name).toBe('First')
      expect(await k.count('contacts')).toBe(1)
      expect(await k.count('identities')).toBe(1)
    })

    it('an invalid entry fails the whole call with its index and writes nothing', async () => {
      const err = await k.fail((env) => resolveOperation(env, [email('ok@example.com'), { kind: 'phone', value: 'abc' }]))
      expect(err.code).toBe('invalid_identity')
      expect(err.message.startsWith('identities[1]: ')).toBe(true)
      expect(await e.rows('events')).toHaveLength(0)
      expect(await k.count('contacts')).toBe(0)
    })

    it('cleans names: padded trimmed, blank absent, long capped at 500', async () => {
      const out = await resolve([email('a@example.com', { name: '  Padded  ' }), email('b@example.com', { name: '   ' }), email('c@example.com', { name: 'x'.repeat(600) })])
      expect(out[0]!.contact!.name).toBe('Padded')
      expect(out[1]!.contact!.name).toBeNull()
      expect(out[2]!.contact!.name).toHaveLength(500)
    })

    it('an empty batch answers [] and sends no statement', async () => {
      const res = await e.run(resolveOperation(k.env(), []))
      expect(res.value).toEqual([])
      expect(res.stats.statements).toBe(res.stats.locks)
    })

    it('emits every contact.created before every identity.created, each in input order (P5)', async () => {
      const out = await resolve([email('a@example.com'), email('b@example.com'), email('c@example.com')])
      const ev = await k.events()
      expect(ev.map((x) => x.type)).toEqual(['contact.created', 'contact.created', 'contact.created', 'identity.created', 'identity.created', 'identity.created'])
      expect(ev.slice(0, 3).map((x) => x.resource_id)).toEqual(out.map((r) => r.contact!.id))
      expect(ev.slice(3).map((x) => x.resource_id)).toEqual(out.map((r) => r.identity.id))
    })

    it("an agent's resolve is attributed to the agent", async () => {
      await resolve([email('a@example.com')], { as: 'agent' })
      for (const ev of await k.events()) expect(ev.actor_id).toBe(e.agentId)
    })

    if (name === 'postgres') {
      it('is per organisation: the same address in another organisation is a separate identity', async () => {
        const [mine] = await resolve([email('shared@example.com')])
        const other = await foreignTenant(e)
        const [theirs] = await other.run(resolveOperation(other.env(), [email('shared@example.com')]))
        expect(theirs!.created).toBe(true)
        expect(theirs!.identity.id).not.toBe(mine!.identity.id)
      })
    }
  })

  describe('ensureOwnIdentity', () => {
    const ensure = (address: { kind: 'email' | 'phone'; value: string }) => k.run((env) => ensureOwnIdentity(env, address))

    it('creates an own identity', async () => {
      const r = await ensure({ kind: 'email', value: ' Me@Us.com ' })
      expect(r.outcome).toBe('created')
      expect(r.identity).toMatchObject({ value: 'me@us.com', own: true, contact_id: null })
      expect((await k.events()).map((x) => x.type)).toEqual(['identity.created'])
    })

    it('moves an address from a contact to own: the contact stays live, the event keeps the previous contact', async () => {
      const c = await k.contact({ name: 'Was' })
      const i = await k.identity({ kind: 'email', value: 'me@us.com', contact_id: c.id })
      const mark = (await k.events()).length
      const r = await ensure({ kind: 'email', value: 'me@us.com' })
      expect(r.outcome).toBe('moved')
      expect(r.identity).toMatchObject({ id: i.id, own: true, contact_id: null })
      const ev = (await k.events()).slice(mark)
      expect(ev.map((x) => x.type)).toEqual(['identity.updated'])
      expect(ev[0]!.before.contact_id).toBe(c.id)
      expect(ev[0]!.after).toEqual(r.identity)
      expect((await k.row('contacts', c.id)).deleted_at).toBeNull()
    })

    it('an address that is already own is unchanged and writes no event', async () => {
      const first = await ensure({ kind: 'email', value: 'me@us.com' })
      const mark = (await e.rows('events')).length
      const again = await ensure({ kind: 'email', value: 'me@us.com' })
      expect(again).toMatchObject({ outcome: 'unchanged', identity: { id: first.identity.id } })
      expect(await e.rows('events')).toHaveLength(mark)
    })

    it('refuses an invalid address', async () => {
      const err = await k.fail((env) => ensureOwnIdentity(env, { kind: 'phone', value: 'abc' }))
      expect(err.code).toBe('invalid_identity')
    })

    it('resolve then sees the own identity', async () => {
      await ensure({ kind: 'email', value: 'me@us.com' })
      const [r] = await resolve([email('me@us.com')])
      expect(r).toMatchObject({ created: false, contact: null, identity: { own: true } })
    })
  })
})
