import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { seedConversation } from '@vault/api/test/messaging'
import { fakeR2Bucket } from '@vault/api/test/objects'
import { fileBlobKey, messageBodyKey } from '@vault/api'
import { clerkMembership, clerkOrganization, clerkWebhook, clerkUser, signClerkWebhook } from '@vault/api/test/clerk'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { NOW, clerkKit, meterD1, openWorkerD1, type ClerkKit, type D1Meter, type InvocationMeasure, type WorkerD1 } from './test/kit.js'

// Spec CORE38 D11 (CORE47 P6-P8): what one request sends to D1, measured through the real composition (local Miniflare,
// not remote), set against Cloudflare's documented limits (fetched 2026-10-28):
//   D1 limits:      https://developers.cloudflare.com/d1/platform/limits/  (a db.batch() call counts as one query)
//   Worker limits:  https://developers.cloudflare.com/workers/platform/limits/
// CPU time is not measured here. Remote numbers belong to OPS4.

const FREE = { queries: 50, subrequests: 50, statementBytes: 100_000, parameters: 100, boundTextBytes: 2_000_000 }
const PAID = { queries: 1_000, subrequests: 10_000 }

/** Scenarios that exceed a Workers Free bound, with the measured value; they are held to the Paid bound instead (P8). */
const FREE_PLAN_EXCEPTIONS: Record<string, string> = {
  // 1 outbound page of 100 members + 99 profile fetches, and two D1 queries (read, write) per first-seen user: 201 queries, 302 subrequests.
  'directory-snapshot-100': 'measured 201 D1 queries and 302 subrequests: needs Workers Paid',
}

/** The exact D1 query count of each scenario, pinned from the first green run: a new round trip is a reviewed change. */
const EXPECTED_QUERIES: Record<string, number> = {
  'cold-first-request': 4, // marker read, auth read, auth stamp, operation read
  'key-auth-stamp': 3, // auth read, auth stamp, operation read
  'key-auth-read': 2, // auth read, operation read
  'task-patch': 3, // auth read, operation read, operation write
  'resolve-100-new': 3,
  'resolve-100-existing': 2,
  'company-delete-100': 3,
  'contact-delete-100': 3,
  'messages-list-50': 2, // auth read, operation read (the embeds are in the same select)
  'messages-content': 2, // auth read, operation read; plus 1 object read
  'files-content': 2, // auth read, operation read; plus 1 object read
  'interactions-list-contact': 2,
  'merge-100-links': 3, // auth read, operation read batch, operation write batch
  'contact-delete-100-with-links': 3,
  'directory-snapshot-5': 11, // 4 first-seen users, two queries each, plus the snapshot's own three
  'directory-snapshot-100': 201, // 99 first-seen users
}

let w: WorkerD1
let kit: ClerkKit
let meter: D1Meter
let now = NOW
let key: string
let worker: { fetch(req: Request): Promise<Response> }
const BASE = 'https://w.test'
const measures = new Map<string, InvocationMeasure & { outbound: number; status: number }>()

const bucket = fakeR2Bucket()
const env = (): D1WorkerEnv => ({ DB: meter.d1, BODIES: bucket, ...kit.env })
const fresh = () => composeD1Worker(env(), { fetch: kit.fetch, clock: () => now, newId: () => uuidv7(now) })
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${key}` }) =>
  new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
const send = async (method: string, path: string, body?: unknown) => {
  const res = await worker.fetch(req(method, path, body))
  return { status: res.status, json: res.status === 204 ? null : ((await res.json()) as any) }
}
/** Meters one request (setup is not metered). */
async function measure(keyName: string, run: () => Promise<{ status: number }>) {
  const callsBefore = kit.fetch.calls.length
  meter.start()
  const res = await run()
  const m = meter.take()
  const outbound = kit.fetch.calls.length - callsBefore
  measures.set(keyName, { ...m, outbound, status: res.status })
  console.log('MEASURE ' + JSON.stringify({ key: keyName, outbound, ...m }))
  return res
}
const count = async (sqlText: string) => Number(((await w.d1.prepare(sqlText).first()) as { n: number }).n)
const webhook = (type: string, data: unknown) => signClerkWebhook(clerkWebhook(type, data), { timestamp: Math.floor(now.getTime() / 1000) })

beforeAll(async () => {
  w = await openWorkerD1()
  kit = await clerkKit()
  meter = meterD1(w.d1)
  const r = await bootstrapD1(w.d1, { organizationName: 'Acme', email: 'owner@x.test', agentName: 'bot', authOrgId: 'org_acme', authSubject: 'user_owner' }, { now: NOW, newId: () => uuidv7(NOW) })
  key = r.key
  worker = fresh()
})
afterAll(() => w.dispose())

const SCENARIOS = ['cold-first-request', 'key-auth-stamp', 'key-auth-read', 'task-patch', 'resolve-100-new', 'resolve-100-existing', 'company-delete-100', 'contact-delete-100', 'messages-list-50', 'messages-content', 'files-content', 'interactions-list-contact', 'merge-100-links', 'contact-delete-100-with-links', 'directory-snapshot-5', 'directory-snapshot-100'] as const
const EXPECTED_STATUS: Record<(typeof SCENARIOS)[number], number> = {
  'cold-first-request': 200,
  'key-auth-stamp': 200,
  'key-auth-read': 200,
  'task-patch': 200,
  'resolve-100-new': 200,
  'resolve-100-existing': 200,
  'company-delete-100': 204,
  'contact-delete-100': 204,
  'messages-list-50': 200,
  'messages-content': 200,
  'files-content': 200,
  'interactions-list-contact': 200,
  'merge-100-links': 200,
  'contact-delete-100-with-links': 204,
  'directory-snapshot-5': 200,
  'directory-snapshot-100': 200,
}

describe('measured limits (local Miniflare, one request = one invocation)', () => {
  it('runs every scenario and returns its success status', async () => {
    // cold: a fresh composition, first request (marker read + stamp)
    worker = fresh()
    await measure('cold-first-request', () => send('GET', '/tasks'))

    // the stamp throttle: older than a minute, then within the minute
    now = new Date(now.getTime() + 2 * 60_000)
    await measure('key-auth-stamp', () => send('GET', '/tasks'))
    await measure('key-auth-read', () => send('GET', '/tasks'))

    const task = (await send('POST', '/tasks', { title: 'one' })).json
    await measure('task-patch', () => send('PATCH', `/tasks/${task.id}`, { title: 'two' }))

    const emails = Array.from({ length: 100 }, (_, i) => ({ kind: 'email', value: `p${i}@measure.test`, name: `P${i}` }))
    await measure('resolve-100-new', () => send('POST', '/identities/resolve', { identities: emails }))
    await measure('resolve-100-existing', () => send('POST', '/identities/resolve', { identities: emails }))

    const company = (await send('POST', '/companies', { name: 'Big Co' })).json
    for (let i = 0; i < 100; i++) await send('POST', '/contacts', { name: `C${i}`, company_id: company.id })
    await measure('company-delete-100', () => send('DELETE', `/companies/${company.id}`))

    const contact = (await send('POST', '/contacts', { name: 'Many' })).json
    for (let i = 0; i < 100; i++) await send('POST', '/identities', { kind: 'email', value: `own${i}@measure.test`, contact_id: contact.id })
    await measure('contact-delete-100', () => send('DELETE', `/contacts/${contact.id}`))

    // CORE25 C1 (D55): the read and merge scenarios. Conversations are seeded by direct inserts on the unmetered D1.
    const orgId = ((await w.d1.prepare('select organization_id as o from deployment').first()) as { o: string }).o
    const creator = ((await w.d1.prepare('select id from principals limit 1').first()) as { id: string }).id
    const insert = async (table: string, row: Record<string, unknown>) => {
      const full: Record<string, unknown> = { id: uuidv7(now), organization_id: orgId, created_by: creator, created_at: now.toISOString(), ...row }
      if (['contact_files', 'company_files'].includes(table)) full.updated_at ??= now.toISOString()
      const cols = Object.keys(full)
      const vals = cols.map((c) => (typeof full[c] === 'boolean' ? (full[c] ? 1 : 0) : full[c] !== null && typeof full[c] === 'object' ? JSON.stringify(full[c]) : (full[c] ?? null)))
      await w.d1.prepare(`insert into "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`).bind(...vals).run()
      return full
    }
    for (let i = 0; i < 50; i++) await seedConversation(insert, { attachments: 2, interaction: false })
    await measure('messages-list-50', () => send('GET', '/messages?limit=50'))

    const withObjects = await seedConversation(insert, { attachments: 1, interaction: false })
    await bucket.put(messageBodyKey(withObjects.contentKey!, 1), '# Measured body')
    await bucket.put(fileBlobKey(withObjects.storageKeys[0]!), new Uint8Array([1, 2, 3]))
    bucket.gets.length = 0
    await measure('messages-content', () => send('GET', `/messages/${withObjects.messageId}/content`))
    expect(bucket.gets).toEqual([messageBodyKey(withObjects.contentKey!, 1)])
    bucket.gets.length = 0
    await measure('files-content', async () => {
      const res = await worker.fetch(req('GET', `/files/${withObjects.fileIds[0]}/content`))
      await res.arrayBuffer()
      return { status: res.status }
    })
    expect(bucket.gets).toEqual([fileBlobKey(withObjects.storageKeys[0]!)])

    const reader = (await send('POST', '/contacts', { name: 'Reader' })).json
    const readerIdentity = (await send('POST', '/identities', { kind: 'email', value: 'reader@measure.test', contact_id: reader.id })).json
    for (let i = 0; i < 50; i++) await seedConversation(insert, { participants: [{ identityId: readerIdentity.id, role: 'from' }] })
    await measure('interactions-list-contact', () => send('GET', `/interactions?contact_id=${reader.id}&limit=50`))

    const files = (await seedConversation(insert, { attachments: 100, interaction: false })).fileIds
    const survivor = (await send('POST', '/contacts', { name: 'Survivor' })).json
    const source = (await send('POST', '/contacts', {})).json
    for (const f of files) await send('POST', '/contact-files', { contact_id: source.id, file_id: f })
    for (const f of files.slice(0, 50)) await send('POST', '/contact-files', { contact_id: survivor.id, file_id: f })
    await measure('merge-100-links', () => send('POST', `/contacts/${survivor.id}/merge`, { source_id: source.id }))

    const linked = (await send('POST', '/contacts', { name: 'Linked' })).json
    const moreFiles = (await seedConversation(insert, { attachments: 100, interaction: false })).fileIds
    for (let i = 0; i < 100; i++) await send('POST', '/identities', { kind: 'email', value: `lk${i}@measure.test`, contact_id: linked.id })
    for (const f of moreFiles) await send('POST', '/contact-files', { contact_id: linked.id, file_id: f })
    await measure('contact-delete-100-with-links', () => send('DELETE', `/contacts/${linked.id}`))

    const snapshot = async (keyName: string, n: number) => {
      const owner = clerkMembership({ organizationId: 'org_acme', userId: 'user_owner', role: 'org:admin' })
      kit.organizations.set('org_acme', clerkOrganization({ id: 'org_acme', name: 'Acme' }))
      kit.profiles.set('user_owner', clerkUser({ id: 'user_owner', email: 'owner@x.test' }))
      const others = Array.from({ length: n - 1 }, (_, i) => clerkMembership({ organizationId: 'org_acme', userId: `user_m${n}_${i}`, role: 'org:member' }))
      for (let i = 0; i < n - 1; i++) kit.profiles.set(`user_m${n}_${i}`, clerkUser({ id: `user_m${n}_${i}`, email: `m${n}_${i}@measure.test` }))
      kit.members.set('org_acme', [owner, ...others])
      const signed = webhook('organization.updated', { id: 'org_acme' })
      return measure(keyName, async () => {
        const res = await worker.fetch(new Request(BASE + '/webhooks/clerk', { method: 'POST', headers: signed.headers, body: signed.body }))
        await res.text()
        return { status: res.status }
      })
    }
    await snapshot('directory-snapshot-5', 5)
    await snapshot('directory-snapshot-100', 100)

    for (const k of SCENARIOS) expect(measures.get(k)?.status, k).toBe(EXPECTED_STATUS[k])
  }, 240_000) // the messaging scenarios seed ~700 rows and ~350 requests before they measure one

  it('every Free-plan exception names a scenario that still exceeds a Free bound', () => {
    for (const k of Object.keys(FREE_PLAN_EXCEPTIONS)) {
      const m = measures.get(k)
      expect(m, `${k} is not a scenario`).toBeDefined()
      expect(m!.queries > FREE.queries || m!.queries + m!.outbound > FREE.subrequests, `${k} no longer exceeds a Free bound: drop its exception`).toBe(true)
    }
  })

  it.each(SCENARIOS)('%s is within the Workers Free limits (or its named Paid exception)', (k) => {
    const m = measures.get(k)!
    const paid = k in FREE_PLAN_EXCEPTIONS
    expect(m.queries).toBeLessThanOrEqual(paid ? PAID.queries : FREE.queries)
    expect(m.queries + m.outbound).toBeLessThanOrEqual(paid ? PAID.subrequests : FREE.subrequests)
    expect(m.maxStatementBytes).toBeLessThanOrEqual(FREE.statementBytes)
    expect(m.maxParameters).toBeLessThanOrEqual(FREE.parameters)
    expect(m.maxBoundTextBytes).toBeLessThanOrEqual(FREE.boundTextBytes)
  })

  it.each(SCENARIOS)('%s sends exactly the pinned number of D1 queries', (k) => {
    expect(measures.get(k)!.queries).toBe(EXPECTED_QUERIES[k])
  })

  it('the cascades really ran at the cap', async () => {
    expect(await count("select count(*) as n from contacts where company_id is null and name like 'C%' and name <> 'Many'")).toBe(100)
    expect(await count('select count(*) as n from identities where deleted_at is not null and own = 0 and value like \'own%\'')).toBe(100)
  })

  it('the messaging scenarios really ran at their sizes', async () => {
    expect(await count('select count(*) as n from messages')).toBe(103) // 50 listed + the content scenarios' one + 50 interactions + the two attachment sets
    expect(await count("select count(*) as n from contact_files where deleted_at is not null")).toBe(50 + 100) // 50 duplicates, then the 100 of the deleted contact
  })

  it('the snapshot really ran at the cap', async () => {
    expect(await count('select count(*) as n from memberships where deleted_at is null')).toBe(100)
  })
})
