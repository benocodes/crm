import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { d1Binding, type D1Like, type D1PreparedLike } from '@vibase/storage-d1'
import { memoryObjectStore } from '../../objects/store.js'
import { openD1Engine, type Engine } from '../../test/engines.js'
import { FAKE_ENDPOINTS, FakeGoogle } from '../../test/google.js'
import { FakeGmail, type BuiltGmailMessage } from '../../test/gmail.js'
import { gmailFixture } from '../../test/gmail-fixtures.js'
import { seedGmailConnection } from '../../test/gmail-sync.js'
import { recordingObjectStore } from '../../test/objects.js'
import { nodeStreams } from '../../test/streams.js'
import { captureHistoryPage, type GmailSyncDeps, type PageResult } from './sync.js'

// [[CORE417]] group 4 (D11): the Gmail sync passes the connection's `contact_creation`, from the settings read the page already makes,
// into the capture unit. D1 only (an unattached identity is refused by the parked Postgres constraint). Local D1 over FakeGmail.
const KEY = new Uint8Array(32).fill(3)
const CONFIG = {
  clientId: 'fake-client-id.apps.test',
  clientSecret: 'fake-client-secret',
  credentialsKey: KEY,
  keyVersion: 1,
  backfillDays: 30,
  attachmentMaxBytes: 50 * 1024 * 1024,
}
const NOW = new Date('2026-11-05T10:00:00.000Z')
const SYNCED = '2026-11-04T10:00:00.000Z'
const OWNER = 'owner@vibase.test'

let e: Engine
let google: FakeGoogle
beforeAll(async () => {
  e = await openD1Engine()
  google = await FakeGoogle.create({ clientId: CONFIG.clientId, clientSecret: CONFIG.clientSecret })
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
})

const received = (id: string, from: string): BuiltGmailMessage =>
  gmailFixture('plain', (s) => ({
    ...s,
    id,
    threadId: `t-${id}`,
    labels: ['INBOX'],
    headers: s.headers.map(([k, v]): [string, string] =>
      k === 'Message-ID' ? [k, `<${id}@acme.test>`] : k === 'From' ? [k, `Some One <${from}>`] : [k, v],
    ),
  }))
const sentTo = (id: string, to: string, cc?: string): BuiltGmailMessage =>
  gmailFixture('plain', (s) => ({
    ...s,
    id,
    threadId: `t-${id}`,
    labels: ['SENT'],
    headers: [
      ...s.headers
        .filter(([k]) => k !== 'From' && k !== 'To')
        .map(([k, v]): [string, string] => (k === 'Message-ID' ? [k, `<${id}@acme.test>`] : [k, v])),
      ['From', OWNER],
      ['To', to],
      ...(cc ? ([['Cc', cc]] as Array<[string, string]>) : []),
    ],
  }))

/** A D1 that records every statement that reads the connection's settings: the capture labels are read in the same batch as the settings columns. */
function countingD1(real: D1Like, seen: string[]): D1Like {
  return {
    prepare(query: string) {
      if (query.includes('connection_capture_labels') || query.includes('"contact_creation"')) seen.push(query)
      return real.prepare(query)
    },
    batch: (statements: D1PreparedLike[]) => real.batch(statements),
  } as D1Like
}

async function setup(contact_creation: 'sent_and_received' | 'sent' | 'none', messages: BuiltGmailMessage[]) {
  const id = await seedGmailConnection(e, {
    key: KEY,
    refreshToken: google.issueRefreshToken(),
    historyId: '1000',
    lastSyncedAt: SYNCED,
  })
  await e
    .d1!.prepare(
      'update connections set contact_creation = ?, exclude_group_addresses = 0, exclude_personal_domains = 0 where id = ?',
    )
    .bind(contact_creation, id)
    .run()
  const gmail = new FakeGmail(messages, { chunk: 2048 })
  const settingsReads: string[] = []
  const deps: GmailSyncDeps = {
    binding: d1Binding(countingD1(e.d1!, settingsReads), {
      organizationId: e.organizationId,
      authProvider: e.authProvider,
      authOrgId: e.authOrgId,
    }),
    organizationId: e.organizationId,
    objects: recordingObjectStore(memoryObjectStore()),
    streams: nodeStreams(),
    clock: () => NOW,
    newId: () => uuidv7(NOW),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    config: CONFIG,
    endpoints: FAKE_ENDPOINTS,
    fetch: google.fetch,
    clientFor: (accessToken) => gmail.withToken(accessToken, (t) => google.isAccessToken(t)),
  }
  gmail.history.push({
    id: '1001',
    added: messages.map((m) => ({ id: m.resource.id, labels: m.resource.labelIds ?? null })),
  })
  gmail.profile.historyId = '1002'
  return { id, deps, settingsReads }
}
const page = (r: PageResult) => {
  if (r.outcome !== 'page') throw new Error(`expected a page, got ${r.outcome}`)
  return r
}
const state = async (value: string) => {
  const i = (await e.rows('identities')).find((x) => x.value === value && x.deleted_at === null)
  return i === undefined ? 'absent' : i.own === true ? 'own' : i.contact_id === null ? 'unattached' : 'contact'
}
const messages = () => [
  received('r1', 'lead@acme.test'),
  sentTo('s1', 'client@acme.test', 'copy@acme.test'),
  received('r2', 'newsletter@acme.test'),
]

describe('the sync passes the connection contact_creation into capture (D11)', () => {
  it('none: every participant of the page is recorded and none gets a contact', async () => {
    const s = await setup('none', messages())
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 3 })
    for (const v of ['lead@acme.test', 'client@acme.test', 'copy@acme.test', 'newsletter@acme.test'])
      expect(await state(v), v).toBe('unattached')
    expect(await e.rows('contacts')).toHaveLength(0)
    expect((await e.rows('interaction_participants')).length).toBe(7)
  })

  it("sent: recipients of the mailbox's own sent mail get contacts, senders of received mail stay unattached", async () => {
    const s = await setup('sent', messages())
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 3 })
    expect(await state('client@acme.test')).toBe('contact')
    expect(await state('copy@acme.test')).toBe('contact')
    expect(await state('lead@acme.test')).toBe('unattached')
    expect(await state('newsletter@acme.test')).toBe('unattached')
    expect(await e.rows('contacts')).toHaveLength(2)
  })

  it('sent_and_received (the default): every counterparty gets a contact, as before', async () => {
    const s = await setup('sent_and_received', messages())
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 3 })
    for (const v of ['lead@acme.test', 'client@acme.test', 'copy@acme.test', 'newsletter@acme.test'])
      expect(await state(v), v).toBe('contact')
  })

  it('the policy comes from the one settings read the page already makes: one read per page, whatever the policy', async () => {
    const s = await setup('sent', messages())
    page(await captureHistoryPage(s.deps, s.id))
    expect(s.settingsReads).toHaveLength(1)
  })
})
