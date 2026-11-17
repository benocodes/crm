import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openD1Engine, type Engine } from '../test/engines.js'
import { identityKit, type IdentityKit } from '../test/identity-kit.js'
import { interactions } from '../resources/interactions.js'
import { ensureOwnIdentity, resolveOperation, type ResolveEntry } from './resolve.js'
import { ApiError, mapStorageError } from '../errors.js'

// [[CORE408]] groups 2 to 4, D1 only (408.19: the parked Postgres constraint refuses an unattached identity, so these
// cannot share the engine suite): an unattached identity is `own false, contact_id null`; resolveProgram's per-entry
// `mayCreateContact` (absent means true, 408.16) decides between a new contact, an unattached identity and a promotion.
let e: Engine
let k: IdentityKit
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  k = identityKit(e)
})
const resolve = (entries: ResolveEntry[]) => k.run((env) => resolveOperation(env, entries))
const email = (value: string, extra: Partial<ResolveEntry> = {}): ResolveEntry => ({ kind: 'email', value, ...extra })
const may = (value: string, extra: Partial<ResolveEntry> = {}) => email(value, { mayCreateContact: true, ...extra })
const mayNot = (value: string, extra: Partial<ResolveEntry> = {}) => email(value, { mayCreateContact: false, ...extra })
const unattached = (value: string) => e.insert('identities', { kind: 'email', value, contact_id: null, own: false })
const types = async () => (await k.events()).map((x) => x.type)

describe('unattached creation (group 2)', () => {
  it('an unknown address that may not have a contact becomes one unattached identity and one identity.created', async () => {
    const [r] = await resolve([mayNot('stranger@x.test', { name: 'Ignored' })])
    expect(r).toMatchObject({
      created: true,
      contact: null,
      identity: { value: 'stranger@x.test', contact_id: null, own: false },
    })
    expect(await k.count('contacts')).toBe(0)
    expect(await k.count('identities')).toBe(1)
    const ev = await k.events()
    expect(ev.map((x) => x.type)).toEqual(['identity.created'])
    expect(ev[0]!.after).toMatchObject({ contact_id: null, own: false })
  })

  it('a mixed batch: may addresses get contact and identity in first-occurrence order, the rest are unattached', async () => {
    const out = await resolve([may('a@x.test', { name: 'A' }), mayNot('b@x.test'), email('c@x.test', { name: 'C' })])
    expect(out.map((r) => r.created)).toEqual([true, true, true])
    expect(out.map((r) => r.contact?.name ?? null)).toEqual(['A', null, 'C'])
    expect(out[1]!.contact).toBeNull()
    expect(await k.count('contacts')).toBe(2)
    const evs = await k.events()
    expect(evs.filter((x) => x.type === 'contact.created').map((x) => x.resource_id)).toEqual([
      out[0]!.contact!.id,
      out[2]!.contact!.id,
    ])
    expect(evs.filter((x) => x.type === 'identity.created').map((x) => x.resource_id)).toEqual(
      out.map((r) => r.identity.id),
    )
  })

  it('an address with one may and one may-not entry gets a contact (408.15), named from the first non-blank name', async () => {
    const [a, b] = await resolve([mayNot('d@x.test', { name: ' ' }), may('D@x.test', { name: 'Dee' })])
    expect(a!.contact).toMatchObject({ name: 'Dee' })
    expect(b!.created).toBe(false)
    expect(await k.count('contacts')).toBe(1)
  })

  it('an address whose entries all say may-not stays unattached, however many entries', async () => {
    const out = await resolve([mayNot('e@x.test'), mayNot('E@x.test')])
    expect(out.map((r) => r.created)).toEqual([true, false])
    expect(await k.count('contacts')).toBe(0)
    expect(await k.count('identities')).toBe(1)
  })

  it('a call with no choice at all is today: a contact and an identity per new address', async () => {
    const [r] = await resolve([email('f@x.test', { name: 'Eff' })])
    expect(r).toMatchObject({ created: true, contact: { name: 'Eff' } })
    expect(await types()).toEqual(['contact.created', 'identity.created'])
  })
})

describe('promotion (group 3)', () => {
  it('a may entry promotes an unattached identity: new contact named from the entry, contact.created + identity.updated', async () => {
    const un = await unattached('p@x.test')
    const [r] = await resolve([may('p@x.test', { name: ' Pat ' })])
    expect(r).toMatchObject({ created: false, contact: { name: 'Pat' }, identity: { id: un.id, own: false } })
    expect(r!.identity.contact_id).toBe(r!.contact!.id)
    const ev = await k.events()
    expect(ev.map((x) => x.type)).toEqual(['contact.created', 'identity.updated'])
    expect(ev[1]!.before).toMatchObject({ contact_id: null, own: false })
    expect(ev[1]!.after).toMatchObject({ contact_id: r!.contact!.id, own: false })
    expect(ev[0]!.after).toEqual(r!.contact)
  })

  it('an empty name gives a nameless contact', async () => {
    await unattached('q@x.test')
    const [r] = await resolve([email('q@x.test', { name: '  ' })])
    expect(r!.contact!.name).toBeNull()
  })

  it('a may-not entry leaves an unattached identity unchanged and writes nothing', async () => {
    const un = await unattached('r@x.test')
    const mark = (await e.rows('events')).length
    const [r] = await resolve([mayNot('r@x.test')])
    expect(r).toMatchObject({ created: false, contact: null, identity: { id: un.id, contact_id: null } })
    expect(await e.rows('events')).toHaveLength(mark)
    expect(await k.count('contacts')).toBe(0)
  })

  it('own and attached identities never change, whatever the choice', async () => {
    const c = await k.contact({ name: 'Held' })
    const attached = await k.identity({ kind: 'email', value: 'att@x.test', contact_id: c.id })
    const own = await k.identity({ kind: 'email', value: 'own@x.test', own: true })
    const mark = (await e.rows('events')).length
    for (const mayCreateContact of [true, false]) {
      const [a, o] = await resolve([
        email('att@x.test', { mayCreateContact }),
        email('own@x.test', { mayCreateContact }),
      ])
      expect(a).toMatchObject({ created: false, contact: { id: c.id }, identity: { id: attached.id } })
      expect(o).toMatchObject({ created: false, contact: null, identity: { id: own.id, own: true } })
    }
    expect(await e.rows('events')).toHaveLength(mark)
    expect(await k.count('contacts')).toBe(1)
  })

  it('an interaction recorded against the unattached identity is listed under the contact after promotion', async () => {
    const un = await unattached('s@x.test')
    const thread = await e.insert('threads', { channel: 'email', subject: 's' })
    const message = await e.insert('messages', {
      thread_id: thread.id,
      channel: 'email',
      kind: 'message',
      external_id: 's@y',
      in_reply_to: null,
      author: { user_id: e.userId },
      occurred_at: '2026-10-22T09:00:00.000Z',
      preview: 'hi',
      content_key: 'orgs/x/',
      version: 1,
      retracted_at: null,
    })
    const inter = await e.insert('interactions', {
      kind: 'message',
      channel: 'email',
      direction: 'inbound',
      occurred_at: '2026-10-22T09:00:00.000Z',
      thread_id: thread.id,
      message_id: message.id,
    })
    await e.insert('interaction_participants', { interaction_id: inter.id, identity_id: un.id, role: 'from' })
    const [r] = await resolve([may('s@x.test')])
    const list = await k.list(interactions, { contact_id: r!.contact!.id })
    expect(list.data.map((x) => x.id)).toEqual([inter.id])
  })
})

describe('promotion drift, one case per guard (group 4)', () => {
  const settle = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (x: unknown) => x,
    )
  const counts = async () => ({
    contacts: await k.count('contacts'),
    events: (await e.rows('events')).length,
  })
  async function drift(value: string, hook: () => Promise<void>) {
    let after: Awaited<ReturnType<typeof counts>> | null = null
    let identityAfter: unknown
    e.betweenPlanAndCommit(async () => {
      await hook()
      after = await counts()
      identityAfter = (await e.rows('identities')).find((i) => i.value === value)
    })
    const err = mapStorageError(await settle(resolve([may(value, { name: 'Late' })])))
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'conflict' })
    expect(await counts()).toEqual(after)
    expect((await e.rows('identities')).find((i) => i.value === value)).toEqual(identityAfter)
  }

  it('(a) attached to another contact in between: nothing written, the retry returns that contact unchanged', async () => {
    const un = await unattached('x1@x.test')
    const other = await e.insert('contacts', { name: 'Other' })
    await drift('x1@x.test', () => e.update('identities', un.id, { contact_id: other.id }))
    const [r] = await resolve([may('x1@x.test')])
    expect(r).toMatchObject({ created: false, contact: { id: other.id } })
    expect(await k.count('contacts')).toBe(1)
  })

  it('(b) soft-deleted in between: nothing written, the retry creates a new contact and identity', async () => {
    const un = await unattached('x2@x.test')
    await drift('x2@x.test', () => e.update('identities', un.id, { deleted_at: '2026-10-22T09:00:00.000Z' }))
    const [r] = await resolve([may('x2@x.test', { name: 'Fresh' })])
    expect(r).toMatchObject({ created: true, contact: { name: 'Fresh' } })
    expect(r!.identity.id).not.toBe(un.id)
  })

  it('(c) made own in between: nothing written, the retry returns the own identity', async () => {
    const un = await unattached('x3@x.test')
    await drift('x3@x.test', () => e.update('identities', un.id, { own: true }))
    const [r] = await resolve([may('x3@x.test')])
    expect(r).toMatchObject({ created: false, contact: null, identity: { id: un.id, own: true } })
    expect(await k.count('contacts')).toBe(0)
  })
})

describe('ensureOwnIdentity over an unattached identity (group 5)', () => {
  it('turns it into own with outcome moved and one identity.updated', async () => {
    const un = await unattached('me@x.test')
    const r = await k.run((env) => ensureOwnIdentity(env, { kind: 'email', value: 'me@x.test' }))
    expect(r).toMatchObject({ outcome: 'moved', identity: { id: un.id, own: true, contact_id: null } })
    expect(await types()).toEqual(['identity.updated'])
  })
})
