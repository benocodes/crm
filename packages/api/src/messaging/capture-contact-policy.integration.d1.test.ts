import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { ApiError, mapStorageError } from '../errors.js'
import { createApp } from '../rest/app.js'
import { SEED_AT } from '../test/insert.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { captureMessage, ensureConnection, runCapture, type CaptureOverrides } from '../test/capture-kit.js'
import { captureChunks, captureMeasure } from './capture-chunks.js'
import type { CaptureInput, CaptureMessage, CaptureParticipant } from './capture.js'

// [[CORE417]] groups 1, 2, 3 and 5, D1 only ([[CORE408]] P6, 408.19: the parked Postgres constraint refuses an unattached
// identity): capture applies the connection's `contact_creation` inside the unit (D4, D6, D7, D10, D11), through `recordMessages`.
type Policy = CaptureInput['contact_creation']
const POLICIES: Policy[] = [undefined, 'sent_and_received', 'sent', 'none']
const CONN_A = uuidv7()
const CONN_B = uuidv7()
const OWNER = 'owner@vibase.test'

let e: Engine
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  await e.insert('identities', { kind: 'email', value: OWNER, contact_id: null, own: true })
  await ensureConnection(e.binding, e, CONN_A)
  await ensureConnection(e.binding, e, CONN_B)
})

const p = (role: CaptureParticipant['role'], value: string, name?: string): CaptureParticipant => ({
  kind: 'email',
  value,
  role,
  ...(name ? { name } : {}),
})
const msg = (over: CaptureOverrides = {}): CaptureMessage => captureMessage(e.organizationId, over)
const cap = (messages: CaptureMessage[], policy?: Policy, connection = CONN_A): ReturnType<typeof runCapture> =>
  runCapture(e, { connection_id: connection, messages, ...(policy === undefined ? {} : { contact_creation: policy }) })
const received = (from: string, over: CaptureOverrides = {}) =>
  msg({ sent_by_connection: false, participants: [p('from', from), p('to', OWNER)], ...over })
const sent = (to: CaptureParticipant[], over: CaptureOverrides = {}) =>
  msg({ sent_by_connection: true, participants: [p('from', OWNER), ...to], ...over })

type State = 'contact' | 'unattached' | 'own'
const live = async () =>
  (await e.rows('identities')).filter((i) => i.deleted_at === null && !String(i.value).endsWith('@seed.test'))
async function states(): Promise<Record<string, State>> {
  const out: Record<string, State> = {}
  for (const i of await live()) {
    out[String(i.value)] = i.own === true ? 'own' : i.contact_id === null ? 'unattached' : 'contact'
  }
  return out
}
const eventTypes = async () => (await e.rows('events')).map((r) => String(r.type))
const countOf = (types: string[], t: string) => types.filter((x) => x === t).length

/** Every cell: participants recorded against the identities, whatever the policy. */
async function participantsRecorded(expected: number) {
  const parts = await e.rows('interaction_participants')
  expect(parts).toHaveLength(expected)
  const ids = new Set((await live()).map((i) => i.id))
  for (const x of parts) expect(ids.has(x.identity_id), 'participant points at a live identity').toBe(true)
}

describe('qualification matrix (group 1: D4, D5, P1, P3)', () => {
  // A received message: its sender never qualifies under `sent`.
  const shapes: Array<{
    name: string
    build: () => CaptureMessage[]
    rows: number
    /** Expected state per non-own address, by policy; `all` is every address that is not own. */
    expect: Record<'default' | 'sent' | 'none', Record<string, State>>
  }> = [
    {
      name: 'received',
      build: () => [received('jane@acme.test')],
      rows: 2,
      expect: {
        default: { 'jane@acme.test': 'contact', [OWNER]: 'own' },
        sent: { 'jane@acme.test': 'unattached', [OWNER]: 'own' },
        none: { 'jane@acme.test': 'unattached', [OWNER]: 'own' },
      },
    },
    {
      name: 'sent with to, cc and bcc',
      build: () => [sent([p('to', 'bob@x.test'), p('cc', 'carol@x.test'), p('bcc', 'dave@x.test')])],
      rows: 4,
      expect: {
        default: { 'bob@x.test': 'contact', 'carol@x.test': 'contact', 'dave@x.test': 'contact', [OWNER]: 'own' },
        sent: { 'bob@x.test': 'contact', 'carol@x.test': 'contact', 'dave@x.test': 'contact', [OWNER]: 'own' },
        none: { 'bob@x.test': 'unattached', 'carol@x.test': 'unattached', 'dave@x.test': 'unattached', [OWNER]: 'own' },
      },
    },
    {
      name: 'sent whose from is a send-as alias also listed as a recipient (P3)',
      build: () => [
        msg({
          sent_by_connection: true,
          participants: [p('from', 'alias@x.test'), p('to', 'alias@x.test'), p('to', 'frank@x.test')],
        }),
      ],
      rows: 3,
      expect: {
        // P1: the default is today's unit, where the alias gets a contact.
        default: { 'alias@x.test': 'contact', 'frank@x.test': 'contact', [OWNER]: 'own' },
        sent: { 'alias@x.test': 'unattached', 'frank@x.test': 'contact', [OWNER]: 'own' },
        none: { 'alias@x.test': 'unattached', 'frank@x.test': 'unattached', [OWNER]: 'own' },
      },
    },
    {
      name: 'a unit where one address is received-only on one message and a recipient of a sent one on another',
      build: () => [
        received('gina@x.test', {
          occurred_at: '2026-10-22T09:00:00.000Z',
          participants: [p('from', 'gina@x.test'), p('to', OWNER), p('cc', 'hank@x.test')],
        }),
        sent([p('to', 'gina@x.test')], { occurred_at: '2026-10-22T09:05:00.000Z' }),
      ],
      rows: 5,
      expect: {
        default: { 'gina@x.test': 'contact', 'hank@x.test': 'contact', [OWNER]: 'own' },
        sent: { 'gina@x.test': 'contact', 'hank@x.test': 'unattached', [OWNER]: 'own' },
        none: { 'gina@x.test': 'unattached', 'hank@x.test': 'unattached', [OWNER]: 'own' },
      },
    },
  ]

  for (const shape of shapes) {
    for (const policy of POLICIES) {
      const label = policy ?? 'absent'
      const key = policy === undefined || policy === 'sent_and_received' ? 'default' : policy
      it(`${shape.name}, policy ${label}`, async () => {
        await cap(shape.build(), policy)
        const got = await states()
        expect(got).toEqual(shape.expect[key])
        const contacts = Object.values(shape.expect[key]).filter((s) => s === 'contact').length
        expect(await e.rows('contacts')).toHaveLength(contacts)
        const types = await eventTypes()
        expect(countOf(types, 'contact.created')).toBe(contacts)
        // identity.created once per non-own address, and never an identity.updated from capture here.
        expect(countOf(types, 'identity.created')).toBe(
          Object.values(shape.expect[key]).filter((s) => s !== 'own').length,
        )
        expect(countOf(types, 'identity.updated')).toBe(0)
        for (const i of await live()) if (i.own !== true && i.contact_id === null) expect(i.own).toBe(false)
        await participantsRecorded(shape.rows)
      })
    }
  }

  it('absent and sent_and_received produce the same unit: the same events in order and the same shapes', async () => {
    const build = () => [
      received('gina@x.test', {
        participants: [p('from', 'gina@x.test', 'Gina'), p('to', OWNER), p('cc', 'hank@x.test')],
      }),
      sent([p('to', 'bob@x.test')]),
    ]
    await cap(build())
    const first = {
      types: await eventTypes(),
      states: await states(),
      names: (await e.rows('contacts')).map((c) => c.name).sort(),
    }
    await e.reset()
    await e.insert('identities', { kind: 'email', value: OWNER, contact_id: null, own: true })
    await ensureConnection(e.binding, e, CONN_A)
    await cap(build(), 'sent_and_received')
    const second = {
      types: await eventTypes(),
      states: await states(),
      names: (await e.rows('contacts')).map((c) => c.name).sort(),
    }
    expect(second).toEqual(first)
    expect(first.names).toEqual(['Gina', null, null])
  })

  it('a contact created under sent takes the display name capture merges', async () => {
    await cap([sent([p('to', 'bob@x.test', 'Bob B')])], 'sent')
    expect((await e.rows('contacts')).map((c) => c.name)).toEqual(['Bob B'])
  })
})

describe('promotion through capture (group 2: D6)', () => {
  const identity = async (value: string) => (await live()).find((i) => i.value === value)!

  it('under sent: an inbound first message leaves the sender unattached; a later reply the mailbox sent promotes the same identity', async () => {
    const first = received('lead@x.test', { occurred_at: '2026-10-22T09:00:00.000Z' })
    await cap([first], 'sent')
    const before = await identity('lead@x.test')
    expect(before).toMatchObject({ contact_id: null, own: false })
    const rowsBefore = await e.rows('interaction_participants')
    const eventsBefore = (await e.rows('events')).length

    const reply = sent([p('to', 'lead@x.test', 'Lead L')], {
      occurred_at: '2026-10-22T09:30:00.000Z',
      in_reply_to: first.external_id,
    })
    await cap([reply], 'sent')

    const after = await identity('lead@x.test')
    expect(after.id).toBe(before.id)
    expect(after.contact_id).not.toBeNull()
    expect(await e.rows('identities').then((r) => r.filter((i) => i.value === 'lead@x.test'))).toHaveLength(1)
    const contacts = await e.rows('contacts')
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({ id: after.contact_id, name: 'Lead L' })

    const fresh = (await e.rows('events')).slice(eventsBefore)
    const types = fresh.map((r) => String(r.type))
    expect(countOf(types, 'contact.created')).toBe(1)
    expect(countOf(types, 'identity.created')).toBe(0)
    const updated = fresh.find((r) => r.type === 'identity.updated' && r.resource_id === before.id)!
    expect(updated).toBeDefined()
    expect((updated.before as any).contact_id).toBeNull()
    expect((updated.after as any).contact_id).toBe(after.contact_id)

    // The first message's participant row is untouched and now reaches the contact with no rewrite.
    const rowsAfter = await e.rows('interaction_participants')
    for (const r of rowsBefore) expect(rowsAfter.find((x) => x.id === r.id)).toEqual(r)
    const fromRow = rowsAfter.find((x) => x.identity_id === before.id && x.role === 'from')!
    expect(fromRow).toBeDefined()
  })

  for (const policy of POLICIES) {
    it(`an address already on a contact, or own, is never changed by capture (policy ${policy ?? 'absent'})`, async () => {
      const c = await e.insert('contacts', { name: 'Existing' })
      await e.insert('identities', { kind: 'email', value: 'att@x.test', contact_id: c.id, own: false })
      const snapshot = async () => ({
        identities: (await live()).filter((i) => ['att@x.test', OWNER].includes(String(i.value))),
        contacts: await e.rows('contacts'),
      })
      const before = await snapshot()
      const eventsBefore = (await e.rows('events')).length
      await cap([sent([p('to', 'att@x.test', 'Renamed')])], policy)
      await cap(
        [received('att@x.test', { participants: [p('from', 'att@x.test', 'Renamed'), p('to', OWNER)] })],
        policy,
      )
      expect(await snapshot()).toEqual(before)
      const fresh = (await e.rows('events')).slice(eventsBefore).map((r) => r.resource_id)
      expect(fresh).not.toContain(c.id)
      expect(fresh).not.toContain(before.identities.find((i) => i.value === 'att@x.test')!.id)
      expect(fresh).not.toContain(before.identities.find((i) => i.value === OWNER)!.id)
    })
  }

  it('drift: the identity is attached by another writer between plan and commit; the unit fails as 409 and the retry creates no second contact', async () => {
    const un = await e.insert('identities', { kind: 'email', value: 'late@x.test', contact_id: null, own: false })
    const other = await e.insert('contacts', { name: 'Other' })
    const m = sent([p('to', 'late@x.test', 'Late')])
    let snapshot: { contacts: number; events: number; messages: number } | null = null
    const take = async () => ({
      contacts: (await e.rows('contacts')).length,
      events: (await e.rows('events')).length,
      messages: (await e.rows('messages')).length,
    })
    e.betweenPlanAndCommit(async () => {
      await e.update('identities', un.id, { contact_id: other.id })
      snapshot = await take()
    })
    const err = mapStorageError(
      await cap([m], 'sent').then(
        () => null,
        (x: unknown) => x,
      ),
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'conflict' })
    expect(await take()).toEqual(snapshot)

    // The pipeline plans again: the identity is attached, so capture leaves it and records the message.
    await cap([m], 'sent')
    expect(await e.rows('contacts')).toHaveLength(1)
    expect((await live()).find((i) => i.value === 'late@x.test')).toMatchObject({ id: un.id, contact_id: other.id })
    expect(await e.rows('messages')).toHaveLength(1)
    expect((await e.rows('interaction_participants')).filter((x) => x.identity_id === un.id)).toHaveLength(1)
  })
})

describe('several mailboxes and going forward (group 3: D7, D10)', () => {
  it('A under sent_and_received, then B under none on the same message: nothing is detached or deleted, B adds no contact', async () => {
    const m = received('shared@x.test')
    await cap([m], 'sent_and_received', CONN_A)
    const contacts = await e.rows('contacts')
    const idents = await live()
    const events = (await e.rows('events')).length
    await cap([m], 'none', CONN_B)
    expect(await e.rows('contacts')).toEqual(contacts)
    expect(await live()).toEqual(idents)
    expect((await e.rows('events')).length).toBe(events)
    expect((await states())['shared@x.test']).toBe('contact')
  })

  it('B under none first, then A under sent_and_received on the same message promotes what B left unattached', async () => {
    const m = received('shared@x.test')
    await cap([m], 'none', CONN_B)
    expect((await states())['shared@x.test']).toBe('unattached')
    const id = (await live()).find((i) => i.value === 'shared@x.test')!.id
    await cap([m], 'sent_and_received', CONN_A)
    expect((await states())['shared@x.test']).toBe('contact')
    expect((await live()).find((i) => i.value === 'shared@x.test')!.id).toBe(id)
    const types = await eventTypes()
    expect(countOf(types, 'contact.created')).toBe(1)
    expect(countOf(types, 'identity.updated')).toBe(1)
  })

  it('A under none leaves addresses unattached; A again under sent on a reply promotes only the recipient', async () => {
    const first = received('p@x.test')
    await cap([first], 'none')
    await cap([sent([p('to', 'p@x.test')], { in_reply_to: first.external_id })], 'sent', CONN_B)
    expect((await states())['p@x.test']).toBe('contact')
  })

  it('connections.update writes nothing to identities or contacts, with unattached identities and with none (D10)', async () => {
    const own = await e.insert('identities', {
      kind: 'email',
      value: 'own-upd@vibase.test',
      contact_id: null,
      own: true,
    })
    const c = await e.insert('channel_connections', {
      provider: 'google',
      account_id: 'sub-upd',
      identity_id: own.id,
      owner_id: e.userId,
      status: 'active',
      granted_scopes: ['openid'],
      connected_at: SEED_AT,
    })
    for (const l of ['INBOX', 'SENT']) await e.insert('connection_capture_labels', { connection_id: c.id, label_id: l })
    const snap = async () => ({
      identities: await e.rows('identities'),
      contacts: await e.rows('contacts'),
      events: (await e.rows('events')).filter((r) => /^(identity|contact)\./.test(String(r.type))),
    })
    // Empty state first: a workspace with no unattached identity and no contact.
    const empty = await snap()
    await updateContactCreation(c.id as string, 'none')
    expect(await snap()).toEqual(empty)

    await cap([received('u1@x.test'), received('u2@x.test')], 'none')
    const before = await snap()
    expect(before.identities.filter((i) => i.contact_id === null && i.own === false)).toHaveLength(2)
    await updateContactCreation(c.id as string, 'sent_and_received')
    await updateContactCreation(c.id as string, 'sent')
    expect(await snap()).toEqual(before)
  })
})

/** The real operation, through the REST route the owner calls. */
async function updateContactCreation(connectionId: string, value: 'sent_and_received' | 'sent' | 'none') {
  const app = createApp({ storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
  const token = mintTestUserToken({
    userId: e.userId,
    organizationId: e.organizationId,
    scopes: ['connections:read', 'connections:write'],
    kind: 'user',
  })
  const res = await app.request(`https://vibase.test/meta/v1/connections/${connectionId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ contact_creation: value }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
}

describe('widest shape at the cap (group 5: 408.30)', () => {
  const addr = (prefix: string, i: number) => `${prefix}${i}@wide.test`

  it('one chunk at the cap with fresh contacts, fresh unattached identities and promotions all non-empty commits in one unit', async () => {
    // 100 distinct addresses (own included): 33 promotions (seeded unattached), 33 fresh contacts, 33 fresh unattached.
    const promote = Array.from({ length: 33 }, (_, i) => addr('pro', i))
    const contactish = Array.from({ length: 33 }, (_, i) => addr('con', i))
    const stranger = Array.from({ length: 33 }, (_, i) => addr('str', i))
    for (const v of promote) await e.insert('identities', { kind: 'email', value: v, contact_id: null, own: false })
    const sentMsg = sent([...promote, ...contactish].map((v) => p('to', v)))
    const recMsg = msg({ participants: [p('from', stranger[0]!), ...stranger.slice(1).map((v) => p('cc', v))] })
    const measured = new Set([sentMsg, recMsg].flatMap((m) => captureMeasure(m).addresses))
    expect(measured.size).toBe(100)
    const { chunks } = captureChunks([sentMsg, recMsg], 100, captureMeasure)
    expect(chunks).toHaveLength(1)

    const out = (await cap(chunks[0]!, 'sent')).value
    expect(out.captured).toHaveLength(2)
    const got = await states()
    for (const v of [...promote, ...contactish]) expect(got[v], v).toBe('contact')
    for (const v of stranger) expect(got[v], v).toBe('unattached')
    const types = await eventTypes()
    expect(countOf(types, 'contact.created')).toBe(66)
    expect(countOf(types, 'identity.updated')).toBe(33)
    expect(countOf(types, 'identity.created')).toBe(66)
    expect(await e.rows('contacts')).toHaveLength(66)
    await participantsRecorded(1 + 66 + 33)
  })
})

describe('the cap is the binding limit (group 5, absence side)', () => {
  it('one address past the cap in a chunk is refused by the binding, so captureChunks must hold the cap', async () => {
    const sentMsg = sent(Array.from({ length: 100 }, (_, i) => p('to', `over${i}@wide.test`)))
    expect(captureMeasure(sentMsg).addresses).toHaveLength(101)
    const err = await cap([sentMsg], 'sent').then(
      () => null,
      (x: unknown) => x,
    )
    expect(err).not.toBeNull()
    expect(String((err as Error).message)).toMatch(/set|limit|exceed/i)
    expect(await e.rows('contacts')).toHaveLength(0)
    // The same message is skipped by the real chunker rather than sent to the binding.
    expect(captureChunks([sentMsg], 100, captureMeasure).skipped).toHaveLength(1)
  })
})

describe('chunking over the cap (group 5)', () => {
  it('captureChunks keeps every set inside the cap for the widest shape: a batch over it splits and each chunk commits', async () => {
    const CAP = 100
    // 12 messages of 20 distinct addresses each: 240 distinct, so the batch splits into chunks of at most 5 messages.
    const batch = Array.from({ length: 12 }, (_, k) =>
      msg({
        sent_by_connection: true,
        participants: [p('from', OWNER), ...Array.from({ length: 19 }, (_, i) => p('to', `k${k}-${i}@split.test`))],
      }),
    )
    const { chunks } = captureChunks(batch, CAP, captureMeasure)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const addresses = new Set(chunk.flatMap((m) => m.participants.map((x) => x.value)))
      expect(addresses.size).toBeLessThanOrEqual(CAP)
      await cap(chunk, 'sent')
    }
    const got = await states()
    expect(Object.values(got).filter((s) => s === 'contact')).toHaveLength(12 * 19)
  })
})
