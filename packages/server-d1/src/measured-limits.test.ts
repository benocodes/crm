import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execute, uuidv7 } from '@vault/storage'
import { MIGRATIONS, d1Binding } from '@vault/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vault/storage-d1/test'
import { seedConversation } from '@vault/api/test/messaging'
import { fakeR2Bucket } from '@vault/api/test/objects'
import { bytesOf, FakeChannel } from '@vault/api/test/channels'
import { nodeStreams } from '@vault/api/test/streams'
import { captureMessage, ensureConnection, tenantEnv } from '@vault/api/test/capture'
import { captureMessages, fileBlobKey, messageBodyKey, r2ObjectStore, recordMessagesOperation } from '@vault/api'
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
  // None since [[CORE64]]: the D1 Worker has no directory webhook, so the two snapshot scenarios (201 queries, 302 subrequests) are gone.
}

/** The exact D1 query count of each scenario, pinned from the first green run: a new round trip is a reviewed change. */
const EXPECTED_QUERIES: Record<string, number> = {
  'cold-first-request': 5, // migration-state read ([[CORE61]] D6, once per isolate), marker read, auth read, auth stamp, operation read
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
  'capture-chunk-1': 2, // read batch, write batch (no route: the unit is run directly, CORE68 D55)
  'capture-chunk-100': 2, // the same two, at the cap: 100 messages, 100 distinct addresses, 100 stored attachments
  'pipeline-batch-25': 3, // CORE69 D16: pre-check read, then the unit's read batch and write batch (25 new messages, one chunk; objects are R2, not D1)
  'pipeline-batch-25-existing': 3, // the same batch again: pre-check, then the unit's two batches (sources only)
}

let w: WorkerD1
let kit: ClerkKit
let meter: D1Meter
let now = NOW
let migrationNow = NOW.getTime()
let key: string
let worker: { fetch(req: Request): Promise<Response> }
const BASE = 'https://w.test'
const measures = new Map<string, InvocationMeasure & { outbound: number; status: number }>()

const bucket = fakeR2Bucket()
const env = (): D1WorkerEnv => ({ DB: meter.d1, BODIES: bucket, ...kit.env })
const fresh = () => composeD1Worker(env(), { fetch: kit.fetch, clock: () => now, nowMs: () => migrationNow, newId: () => uuidv7(now) })
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${key}` }) =>
  new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
const send = async (method: string, path: string, body?: unknown) => {
  const res = await worker.fetch(req(method, path, body))
  return { status: res.status, json: res.status === 204 ? null : ((await res.json()) as any) }
}
/** Meters one request (setup is not metered). */
async function measure(keyName: string, run: () => Promise<{ status: number }>) {
  migrationNow += 6_000 // Cross the migration recheck window regardless of fixture setup speed.
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

beforeAll(async () => {
  w = await openWorkerD1()
  // Query budgets model a migrated deployment, including Wrangler's tracker.
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name))
  kit = await clerkKit()
  meter = meterD1(w.d1)
  const r = await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme' }, { now: NOW, newId: () => uuidv7(NOW) })
  key = r.key
  worker = fresh()
}, 30_000)
afterAll(() => w?.dispose())

const SCENARIOS = ['cold-first-request', 'key-auth-stamp', 'key-auth-read', 'task-patch', 'resolve-100-new', 'resolve-100-existing', 'company-delete-100', 'contact-delete-100', 'messages-list-50', 'messages-content', 'files-content', 'interactions-list-contact', 'merge-100-links', 'contact-delete-100-with-links', 'capture-chunk-1', 'capture-chunk-100', 'pipeline-batch-25', 'pipeline-batch-25-existing'] as const
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
  'capture-chunk-1': 200,
  'capture-chunk-100': 200,
  'pipeline-batch-25': 200,
  'pipeline-batch-25-existing': 200,
}

describe('measured limits (local Miniflare, one request = one invocation)', () => {
  it('runs every scenario and returns its success status', async () => {
    // cold: a fresh composition, first request (marker read + stamp)
    worker = fresh()
    await measure('cold-first-request', () => send('GET', '/api/v1/tasks'))

    // the stamp throttle: older than a minute, then within the minute
    now = new Date(now.getTime() + 2 * 60_000)
    await measure('key-auth-stamp', () => send('GET', '/api/v1/tasks'))
    await measure('key-auth-read', () => send('GET', '/api/v1/tasks'))

    const task = (await send('POST', '/api/v1/tasks', { title: 'one' })).json
    await measure('task-patch', () => send('PATCH', `/api/v1/tasks/${task.id}`, { title: 'two' }))

    const emails = Array.from({ length: 100 }, (_, i) => ({ kind: 'email', value: `p${i}@measure.test`, name: `P${i}` }))
    await measure('resolve-100-new', () => send('POST', '/api/v1/identities/resolve', { identities: emails }))
    await measure('resolve-100-existing', () => send('POST', '/api/v1/identities/resolve', { identities: emails }))

    const company = (await send('POST', '/api/v1/companies', { name: 'Big Co' })).json
    for (let i = 0; i < 100; i++) await send('POST', '/api/v1/contacts', { name: `C${i}`, company_id: company.id })
    await measure('company-delete-100', () => send('DELETE', `/api/v1/companies/${company.id}`))

    const contact = (await send('POST', '/api/v1/contacts', { name: 'Many' })).json
    for (let i = 0; i < 100; i++) await send('POST', '/api/v1/identities', { kind: 'email', value: `own${i}@measure.test`, contact_id: contact.id })
    await measure('contact-delete-100', () => send('DELETE', `/api/v1/contacts/${contact.id}`))

    // CORE25 C1 (D55): the read and merge scenarios. Conversations are seeded by direct inserts on the unmetered D1.
    const orgId = ((await w.d1.prepare('select organization_id as o from deployment').first()) as { o: string }).o
    // A user, not the first principal (an agent): a connection's owner is a user (CHN140 D31), and the seeded sources name a connection.
    const creator = uuidv7(now)
    await w.d1.batch([
      w.d1.prepare('insert into principals (id, kind, created_at) values (?, ?, ?)').bind(creator, 'user', now.toISOString()),
      w.d1.prepare('insert into users (id, created_at, updated_at, email, email_verified) values (?, ?, ?, ?, 0)').bind(creator, now.toISOString(), now.toISOString(), 'measure-owner@measure.test'),
    ])
    const insert = async (table: string, row: Record<string, unknown>) => {
      const full: Record<string, unknown> = { id: uuidv7(now), organization_id: orgId, created_by: creator, created_at: now.toISOString(), ...row }
      if (['contact_files', 'company_files', 'identities', 'channel_connections'].includes(table)) full.updated_at ??= now.toISOString()
      const cols = Object.keys(full)
      const vals = cols.map((c) => (typeof full[c] === 'boolean' ? (full[c] ? 1 : 0) : full[c] !== null && typeof full[c] === 'object' ? JSON.stringify(full[c]) : (full[c] ?? null)))
      await w.d1.prepare(`insert into "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`).bind(...vals).run()
      return full
    }
    for (let i = 0; i < 50; i++) await seedConversation(insert, { attachments: 2, interaction: false })
    await measure('messages-list-50', () => send('GET', '/api/v1/messages?limit=50'))

    const withObjects = await seedConversation(insert, { attachments: 1, interaction: false })
    await bucket.put(messageBodyKey(withObjects.contentKey!, 1), '# Measured body')
    await bucket.put(fileBlobKey(withObjects.storageKeys[0]!), new Uint8Array([1, 2, 3]))
    bucket.gets.length = 0
    await measure('messages-content', () => send('GET', `/api/v1/messages/${withObjects.messageId}/content`))
    expect(bucket.gets).toEqual([messageBodyKey(withObjects.contentKey!, 1)])
    bucket.gets.length = 0
    await measure('files-content', async () => {
      const res = await worker.fetch(req('GET', `/api/v1/files/${withObjects.fileIds[0]}/content`))
      await res.arrayBuffer()
      return { status: res.status }
    })
    expect(bucket.gets).toEqual([fileBlobKey(withObjects.storageKeys[0]!)])

    const reader = (await send('POST', '/api/v1/contacts', { name: 'Reader' })).json
    const readerIdentity = (await send('POST', '/api/v1/identities', { kind: 'email', value: 'reader@measure.test', contact_id: reader.id })).json
    for (let i = 0; i < 50; i++) await seedConversation(insert, { participants: [{ identityId: readerIdentity.id, role: 'from' }] })
    await measure('interactions-list-contact', () => send('GET', `/api/v1/interactions?contact_id=${reader.id}&limit=50`))

    const files = (await seedConversation(insert, { attachments: 100, interaction: false })).fileIds
    const survivor = (await send('POST', '/api/v1/contacts', { name: 'Survivor' })).json
    const source = (await send('POST', '/api/v1/contacts', {})).json
    for (const f of files) await send('POST', '/api/v1/contact-files', { contact_id: source.id, file_id: f })
    for (const f of files.slice(0, 50)) await send('POST', '/api/v1/contact-files', { contact_id: survivor.id, file_id: f })
    await measure('merge-100-links', () => send('POST', `/api/v1/contacts/${survivor.id}/merge`, { source_id: source.id }))

    const linked = (await send('POST', '/api/v1/contacts', { name: 'Linked' })).json
    const moreFiles = (await seedConversation(insert, { attachments: 100, interaction: false })).fileIds
    for (let i = 0; i < 100; i++) await send('POST', '/api/v1/identities', { kind: 'email', value: `lk${i}@measure.test`, contact_id: linked.id })
    for (const f of moreFiles) await send('POST', '/api/v1/contact-files', { contact_id: linked.id, file_id: f })
    await measure('contact-delete-100-with-links', () => send('DELETE', `/api/v1/contacts/${linked.id}`))

    // CORE68 D55: the capture unit at 1 and at the cap (100 messages, 100 distinct addresses, 100 stored attachments), run through the metered binding.
    const binding = d1Binding(meter.d1, { organizationId: orgId, authProvider: 'clerk', authOrgId: 'org_acme' })
    // CHN140 D27: the sources name a connection, so the measured captures name one that exists.
    const captureConnection = uuidv7(now)
    await ensureConnection(binding, { organizationId: orgId, userId: creator }, captureConnection)
    const captureAt = (messages: ReturnType<typeof captureMessage>[]) => async () => {
      await execute(binding, { kind: 'tenant', actorId: creator, organizationId: orgId }, recordMessagesOperation(tenantEnv({ organizationId: orgId, userId: creator, agentId: creator }, now), { connection_id: captureConnection, messages }))
      return { status: 200 }
    }
    await measure('capture-chunk-1', captureAt([captureMessage(orgId, { attachments: 1 })]))
    const hundred = Array.from({ length: 100 }, (_, i) =>
      captureMessage(orgId, {
        attachments: 1,
        participants: [
          { kind: 'email', value: `s${i % 50}@measure.test`, role: 'from' },
          { kind: 'email', value: `r${i % 50}@measure.test`, role: 'to' },
        ],
      }),
    )
    await measure('capture-chunk-100', captureAt(hundred))

    // CORE69 D16: a page of 25 through the content pipeline (FakeChannel, memory-fast Node streams, the fake bucket), then the same page again.
    const channel = new FakeChannel(
      Array.from({ length: 25 }, (_, i) => ({ providerMessageId: `pipe-${i}`, from: `ps${i}@measure.test`, to: [`pr${i}@measure.test`], attachments: [{ name: `p${i}.bin`, bytes: bytesOf(32, i) }] })),
    )
    const pageIds = Array.from({ length: 25 }, (_, i) => `pipe-${i}`)
    const pipelineConnection = uuidv7(now)
    await ensureConnection(binding, { organizationId: orgId, userId: creator }, pipelineConnection)
    const pipeline = () => async () => {
      await captureMessages(
        { binding, organizationId: orgId, actorId: creator, objects: r2ObjectStore(bucket), streams: nodeStreams(), clock: () => now, newId: () => uuidv7(now), randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
        channel,
        { id: pipelineConnection },
        pageIds,
      )
      return { status: 200 }
    }
    await measure('pipeline-batch-25', pipeline())
    await measure('pipeline-batch-25-existing', pipeline())

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
    expect(await count('select count(*) as n from messages')).toBe(229) // 50 listed + the content scenarios' one + 50 interactions + the two attachment sets + the capture chunks' 1 and 100, the pipeline's 25
    expect(await count("select count(*) as n from contact_files where deleted_at is not null")).toBe(50 + 100) // 50 duplicates, then the 100 of the deleted contact
  })
})
