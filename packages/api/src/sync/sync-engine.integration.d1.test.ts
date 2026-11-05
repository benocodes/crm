import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { SCOPE_POLICY, type Role, type ScopePolicy } from '../auth/roles.js'
import { GmailApiError } from '../channels/gmail/client.js'
import type { GmailSyncDeps } from '../channels/gmail/sync.js'
import { memoryObjectStore } from '../objects/store.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { FAKE_ENDPOINTS, FakeGoogle } from '../test/google.js'
import { FakeGmail, type BuiltGmailMessage } from '../test/gmail.js'
import { gmailFixture } from '../test/gmail-fixtures.js'
import { seedGmailConnection } from '../test/gmail-sync.js'
import { nodeStreams } from '../test/streams.js'
import { makeWorkerdStepShim, type ShimOptions } from '../test/workerd-boundary.js'
import { claimLease, extendLease, finishPass, LEASE_MS } from './lease.js'
import { runMailSync, type MailSyncRuntime } from './workflow-run.js'
import type { MailSyncParams } from './request.js'

// [[CHN141]] / [[CHN5]] cycle 4: the sync run (`runMailSync`) on local D1 over the real page service, FakeGmail, FakeGoogle's token endpoint and
// the workerd step shim. Nothing reaches the network.
const KEY = new Uint8Array(32).fill(3)
const CONFIG = { clientId: 'fake-client-id.apps.test', clientSecret: 'fake-client-secret', credentialsKey: KEY, keyVersion: 1, backfillDays: 30, attachmentMaxBytes: 50 * 1024 * 1024 }
const NOW = new Date('2026-11-05T10:00:00.000Z')
const SYNCED = '2026-11-04T10:00:00.000Z'
const ONE_HOUR = 3_600_000

let e: Engine
let google: FakeGoogle
let now: Date
beforeAll(async () => {
  e = await openD1Engine()
  google = await FakeGoogle.create({ clientId: CONFIG.clientId, clientSecret: CONFIG.clientSecret })
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  now = new Date(NOW)
})
afterEach(() => {
  vi.restoreAllMocks()
  google.failRefresh(null)
  google.rotateRefreshTokens(false)
})

const mk = (id: string, over: { labels?: string[]; internalDate?: number } = {}): BuiltGmailMessage =>
  gmailFixture('plain', (s) => ({
    ...s,
    id,
    threadId: `t-${id}`,
    headers: s.headers.map(([k, v]): [string, string] => [k, k === 'Message-ID' ? `<${id}@acme.test>` : v]),
    ...(over.labels ? { labels: over.labels } : {}),
    internalDate: over.internalDate ?? NOW.getTime() - ONE_HOUR,
  }))
const many = (n: number, prefix: string): BuiltGmailMessage[] => Array.from({ length: n }, (_, i) => mk(`${prefix}${String(i).padStart(3, '0')}`))

interface Setup {
  gmail: FakeGmail
  pages: GmailSyncDeps
  rt: MailSyncRuntime
  id: string
  refreshToken: string
  created: Array<{ id: string; params: MailSyncParams }>
  state: { behind: boolean; roles: Map<string, Role | null>; roleFailure: boolean; policy: ScopePolicy }
}
async function setup(opts: { messages?: BuiltGmailMessage[]; synced?: string | null; historyId?: string; noProvider?: boolean; mailbox?: string; sub?: string } = {}): Promise<Setup> {
  const refreshToken = google.issueRefreshToken()
  const id = await seedGmailConnection(e, { key: KEY, refreshToken, historyId: opts.historyId ?? '1000', lastSyncedAt: opts.synced === undefined ? SYNCED : opts.synced, ...(opts.mailbox ? { mailbox: opts.mailbox } : {}), ...(opts.sub ? { sub: opts.sub } : {}) })
  const gmail = new FakeGmail(opts.messages ?? [], { chunk: 2048 })
  const pages: GmailSyncDeps = {
    binding: e.binding,
    organizationId: e.organizationId,
    objects: memoryObjectStore(),
    streams: nodeStreams(),
    clock: () => now,
    newId: () => uuidv7(now),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    config: CONFIG,
    endpoints: FAKE_ENDPOINTS,
    fetch: google.fetch,
    clientFor: (accessToken) => gmail.withToken(accessToken, (t) => google.isAccessToken(t)),
  }
  const created: Setup['created'] = []
  const state: Setup['state'] = { behind: false, roles: new Map([['user_engine_1', 'owner']]), roleFailure: false, policy: SCOPE_POLICY }
  const rt: MailSyncRuntime = {
    pages,
    gate: async () => {
      if (state.behind) throw new Error('migrations_pending: the database is behind this build')
    },
    roleOf: opts.noProvider
      ? null
      : async (subject) => {
          if (state.roleFailure) throw new Error('role source down')
          return state.roles.get(subject) ?? null
        },
    get policy() {
      return state.policy
    },
    declaredScopes: Object.keys(SCOPE_POLICY),
    instances: { create: async (o) => void created.push(o) },
  }
  return { gmail, pages, rt, id, refreshToken, created, state }
}
const run = (s: Setup, shim = makeWorkerdStepShim()) => runMailSync({ payload: { connection_id: s.id } }, shim.step, () => s.rt)
const addHistory = (g: FakeGmail, id: string, added: string[]) => g.history.push({ id, added: added.map((a) => ({ id: a, labels: ['INBOX'] })) })
const stateRow = async () => (await e.rows('mail_sync_state'))[0]!
const cursor = async () => (await e.rows('mail_sync_cursors'))[0]!
const eventsOf = async (type: string) => (await e.rows('events')).filter((r) => r.type === type)
const connection = async () => (await e.rows('channel_connections'))[0]!
const raw = (sqlText: string, ...binds: unknown[]) => e.d1!.prepare(sqlText).bind(...binds).run()
const calls = (g: FakeGmail, op: string) => g.calls.filter((c) => c.op === op)
const snapshot = async () => ({ state: await e.rows('mail_sync_state'), cursor: await e.rows('mail_sync_cursors'), events: (await e.rows('events')).length, messages: (await e.rows('messages')).length, conn: await e.rows('channel_connections') })

describe('step returns (invariant 7)', () => {
  it('every step of a full run (backfill, history, finish) returns plain ids, counts, tokens, bounds and outcomes that survive the workerd shim, and no secret', async () => {
    const s = await setup({ messages: [...many(3, 'b'), mk('h1')], synced: null })
    addHistory(s.gmail, '1001', ['h1'])
    s.gmail.profile.historyId = '1002'
    google.rotateRefreshTokens(true)
    const shim = makeWorkerdStepShim()
    const out = await run(s, shim)
    expect(out).toEqual({ end: 'complete', passes: 1 })
    expect(shim.names).toEqual(['seed', 'claim', 'p1-begin-backfill', 'p1-backfill-1', 'p1-history-1', 'p1-finish'])
    const allowed = new Set(['run_id', 'started_at', 'claimed', 'reason', 'owner_id', 'needs_backfill', 'outcome', 'scan', 'kind', 'after', 'history_id', 'next_page_token', 'captured', 'existing', 'skipped', 'retry_after_seconds', 'again', 'requested', 'at'])
    const keys = (v: unknown): string[] => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : [])
    for (const r of shim.returns) for (const k of keys(r.value)) expect(allowed.has(k), `${r.name}.${k}`).toBe(true)
    const text = JSON.stringify(shim.returns)
    for (const secret of [s.refreshToken, ...google.refreshTokens, ...google.accessTokens, CONFIG.clientSecret]) expect(text).not.toContain(secret)
    expect(shim.returns.find((r) => r.name === 'claim')!.value).toEqual({ claimed: true, owner_id: e.userId, needs_backfill: true })
  })
})

describe('lease (D11)', () => {
  const lease = () => ({ binding: e.binding, organizationId: e.organizationId, clock: () => now })
  it('claims a free lease, refuses a held one with nothing written, takes an expired one over, and takes back its own', async () => {
    const s = await setup()
    expect(await claimLease(lease(), s.id, 'run-a')).toBe(true)
    expect(await stateRow()).toMatchObject({ run_id: 'run-a', lease_until: new Date(now.getTime() + LEASE_MS).toISOString() })
    const held = await stateRow()
    now = new Date(now.getTime() + 60_000)
    expect(await claimLease(lease(), s.id, 'run-b')).toBe(false)
    expect(await stateRow()).toEqual(held)
    expect(await claimLease(lease(), s.id, 'run-a')).toBe(true) // its own, retried after its unit committed
    expect(await stateRow()).toMatchObject({ run_id: 'run-a', lease_until: new Date(now.getTime() + LEASE_MS).toISOString() }) // and pushed it out again
    now = new Date(now.getTime() + LEASE_MS + 1)
    expect(await claimLease(lease(), s.id, 'run-b')).toBe(true) // expired
    expect((await stateRow()).run_id).toBe('run-b')
  })
  it('a page extension by a run that lost its lease writes nothing; the holder extends', async () => {
    const s = await setup()
    await claimLease(lease(), s.id, 'run-a')
    now = new Date(now.getTime() + LEASE_MS + 1)
    await claimLease(lease(), s.id, 'run-b')
    const before = await stateRow()
    now = new Date(now.getTime() + 1000)
    expect(await extendLease(lease(), s.id, 'run-a')).toBe(false)
    expect(await stateRow()).toEqual(before)
    expect(await extendLease(lease(), s.id, 'run-b')).toBe(true)
    expect((await stateRow()).lease_until).toBe(new Date(now.getTime() + LEASE_MS).toISOString())
  })
  it('finish releases only the holder, and keeps the lease only when a later request wants another pass', async () => {
    const s = await setup()
    await claimLease(lease(), s.id, 'run-a')
    const start = now.toISOString()
    expect(await finishPass(lease(), s.id, 'run-b', start, true)).toMatchObject({ again: false })
    expect((await stateRow()).run_id).toBe('run-a') // not b's to release
    expect((await stateRow()).last_success_at).toBeNull()
    expect(await finishPass(lease(), s.id, 'run-a', start, true)).toMatchObject({ again: false, requested: false })
    expect(await stateRow()).toMatchObject({ run_id: null, lease_until: null })
    expect((await stateRow()).last_success_at).not.toBeNull()
  })
  it('a second run while the lease is held ends at claim with nothing written', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    await claimLease(lease(), s.id, 'someone-else')
    const before = await snapshot()
    const shim = makeWorkerdStepShim()
    expect(await run(s, shim)).toEqual({ end: 'held', passes: 0 })
    expect(shim.names).toEqual(['seed', 'claim'])
    expect(await snapshot()).toEqual(before)
    expect(s.gmail.calls).toEqual([])
  })
  it('an expired lease is taken over by a run, which completes and releases it', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    await claimLease(lease(), s.id, 'dead-run')
    now = new Date(now.getTime() + LEASE_MS + 1)
    expect((await run(s)).end).toBe('complete')
    expect(await stateRow()).toMatchObject({ run_id: null, lease_until: null })
    expect((await e.rows('messages')).length).toBe(1)
  })
  it('a claim step retried after its unit committed takes back its own lease, not claimed:false', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    const shim = makeWorkerdStepShim({
      retries: 1,
      afterCommit: (name, attempt) => {
        if (name === 'claim' && attempt === 0) throw new Error('step failed after its unit committed')
      },
    })
    expect((await run(s, shim)).end).toBe('complete')
    expect(shim.names.filter((n) => n === 'claim')).toHaveLength(2)
    expect((await e.rows('messages')).length).toBe(1)
  })
  it('a run whose lease was taken mid-run ends without writing the page', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    const shim = makeWorkerdStepShim({
      beforeStep: async (name) => {
        if (name === 'p1-history-1') await raw("update mail_sync_state set run_id = 'thief', lease_until = ?", new Date(now.getTime() + LEASE_MS).toISOString())
      },
    })
    expect(await run(s, shim)).toEqual({ end: 'lease_lost', passes: 1 })
    expect((await e.rows('messages')).length).toBe(0)
    expect((await stateRow()).run_id).toBe('thief')
    expect(s.gmail.calls).toEqual([])
  })
})

describe('resume', () => {
  it('a run killed after page 1 of a history walk resumes from the stored page token: no duplicate rows or events, no message fetched twice', async () => {
    const msgs = many(60, 'h')
    const s = await setup({ messages: msgs })
    msgs.forEach((m, i) => addHistory(s.gmail, String(1001 + i), [m.resource.id]))
    s.gmail.profile.historyId = '1100'
    const killed = makeWorkerdStepShim({
      beforeStep: (name) => {
        if (name === 'p1-history-2') throw new Error('instance killed')
      },
    })
    await expect(run(s, killed)).rejects.toThrow('instance killed')
    expect((await cursor()).page_token).toBe('h25')
    expect((await e.rows('messages')).length).toBe(25)
    now = new Date(now.getTime() + LEASE_MS + 1)
    expect((await run(s)).end).toBe('complete')
    expect(calls(s.gmail, 'history').map((c) => c.pageToken)).toEqual([null, 'h25', 'h50'])
    const fetched = calls(s.gmail, 'full').map((c) => c.messageId)
    expect(new Set(fetched).size).toBe(fetched.length)
    expect(fetched).toHaveLength(60)
    expect((await e.rows('messages')).length).toBe(60)
    expect((await eventsOf('message.created')).length).toBe(60)
    expect(await cursor()).toMatchObject({ history_id: '1100', page_token: null })
  })
  it('a run killed mid-backfill rescans: nothing already sourced is fetched twice, and every message ends captured', async () => {
    const s = await setup({ messages: many(60, 'b'), synced: null })
    const killed = makeWorkerdStepShim({
      beforeStep: (name) => {
        if (name === 'p1-backfill-3') throw new Error('instance killed')
      },
    })
    await expect(run(s, killed)).rejects.toThrow('instance killed')
    expect((await cursor()).last_synced_at).toBeNull()
    expect((await e.rows('messages')).length).toBe(50)
    now = new Date(now.getTime() + LEASE_MS + 1)
    const shim = makeWorkerdStepShim()
    expect((await run(s, shim)).end).toBe('complete')
    expect(shim.names).toContain('p1-backfill-3')
    const fetched = calls(s.gmail, 'full').map((c) => c.messageId)
    expect(new Set(fetched).size).toBe(fetched.length)
    expect((await e.rows('messages')).length).toBe(60)
    expect((await cursor()).last_synced_at).not.toBeNull()
  })
})

describe('again (D11)', () => {
  const requestDuring = (at: (n: number) => string, stepName: (pass: number) => string) =>
    makeWorkerdStepShim({
      beforeStep: async (name) => {
        for (const pass of [1, 2, 3]) if (name === stepName(pass)) await raw('update mail_sync_state set sync_requested_at = ?', at(pass))
      },
    })
  it('a request later than the pass start gives one more pass; at most 3, then a new instance is created for what is still requested', async () => {
    const s = await setup()
    const later = (pass: number) => new Date(now.getTime() + pass * 1000).toISOString()
    const shim = requestDuring(later, (p) => `p${p}-finish`)
    const out = await run(s, shim)
    expect(out).toEqual({ end: 'complete', passes: 3 })
    expect(shim.names.filter((n) => n.endsWith('-finish'))).toEqual(['p1-finish', 'p2-finish', 'p3-finish'])
    expect(shim.names).toContain('chain')
    expect(s.created).toHaveLength(1)
    expect(s.created[0]!.params).toEqual({ connection_id: s.id })
    expect(s.created[0]!.id).toMatch(new RegExp(`^mail-sync-${s.id}-[0-9a-f-]{36}$`))
    expect(await stateRow()).toMatchObject({ run_id: null, lease_until: null })
  })
  it('exactly one extra pass when only the first pass sees a request', async () => {
    const s = await setup()
    const shim = makeWorkerdStepShim({
      beforeStep: async (name) => {
        if (name === 'p1-finish') {
          await raw('update mail_sync_state set sync_requested_at = ?', new Date(now.getTime() + 1000).toISOString())
          now = new Date(now.getTime() + 2000) // the pass ends after the request, so the next pass starts later than it
        }
      },
    })
    expect(await run(s, shim)).toEqual({ end: 'complete', passes: 2 })
    expect(shim.names).not.toContain('chain')
    expect(s.created).toEqual([])
  })
  it('a request earlier than the run start, or none at all, ends after one pass', async () => {
    const s = await setup()
    await raw('update mail_sync_state set sync_requested_at = ?', new Date(now.getTime() - 60_000).toISOString())
    expect(await run(s)).toEqual({ end: 'complete', passes: 1 })
  })
  it('empty state: no sync_requested_at ends after one pass', async () => {
    const s = await setup()
    expect((await stateRow()).sync_requested_at).toBeNull()
    expect(await run(s)).toEqual({ end: 'complete', passes: 1 })
  })
})

describe('throttle (D16)', () => {
  const throttle = (g: FakeGmail, times: number, retryAfterSeconds: number | null) => {
    let n = 0
    g.failWhen((c) => c.op === 'history' && n++ < times, new GmailApiError({ status: 429, gmailStatus: 'RESOURCE_EXHAUSTED', ...(retryAfterSeconds !== null ? { retryAfter: String(retryAfterSeconds), retryAfterSeconds } : {}) }))
  }
  it('sleeps the Retry-After and retries the same page', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    throttle(s.gmail, 1, 7)
    const shim = makeWorkerdStepShim()
    expect((await run(s, shim)).end).toBe('complete')
    expect(shim.sleeps.map((x) => x.duration)).toEqual(['7 seconds'])
    expect(calls(s.gmail, 'history').map((c) => [c.startHistoryId, c.pageToken])).toEqual([['1000', null], ['1000', null]])
    expect((await e.rows('messages')).length).toBe(1)
  })
  it('sleeps 30 seconds when Google sent no Retry-After', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    throttle(s.gmail, 2, null)
    const shim = makeWorkerdStepShim()
    await run(s, shim)
    expect(shim.sleeps.map((x) => x.duration)).toEqual(['30 seconds', '30 seconds'])
  })
  it('the sixth throttle throws to the retry policy after five sleeps', async () => {
    const s = await setup()
    throttle(s.gmail, 99, 1)
    const shim = makeWorkerdStepShim()
    await expect(run(s, shim)).rejects.toThrow(/throttled/i)
    expect(shim.sleeps).toHaveLength(5)
  })
})

describe('expired history (D13)', () => {
  it('a history 404 runs the recovery scan as its own steps and ends with the fresh history id stored', async () => {
    const s = await setup({ messages: [mk('old1'), mk('old2')], historyId: '1000' })
    s.gmail.expireHistoryBefore = 2000
    s.gmail.profile.historyId = '2500'
    const shim = makeWorkerdStepShim({})
    const out = await run(s, shim)
    expect(out.end).toBe('complete')
    expect(shim.names).toEqual(['seed', 'claim', 'p1-history-1', 'p1-begin-recovery', 'p1-recovery-1', 'p1-history-2', 'p1-finish'])
    expect((await cursor()).history_id).toBe('2500')
    expect((await e.rows('messages')).length).toBe(2)
  })
})

describe('reauth and suspended (D16, D33, D69)', () => {
  it('invalid_grant ends the run with the lease released and exactly one connection.updated by the owner', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    google.revoke(s.refreshToken)
    const before = (await eventsOf('connection.updated')).length
    const shim = makeWorkerdStepShim()
    expect(await run(s, shim)).toEqual({ end: 'reauth', passes: 1 })
    expect(shim.names).toContain('record-failure')
    expect(await stateRow()).toMatchObject({ run_id: null, lease_until: null, last_error_code: 'invalid_grant' })
    expect((await connection()).status).toBe('reauth_required')
    const events = await eventsOf('connection.updated')
    expect(events.length - before).toBe(1)
    expect(events.at(-1)!.actor_id).toBe(e.userId)
  })
  it('an owner whose role is gone (404 from the role source) is suspended with one event by the owner and no Google call', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    s.state.roles.delete('user_engine_1')
    const before = (await eventsOf('connection.updated')).length
    const refreshes = google.refreshRequests.length
    expect(await run(s)).toEqual({ end: 'suspended', passes: 0 })
    expect((await connection()).status).toBe('suspended')
    const events = await eventsOf('connection.updated')
    expect(events.length - before).toBe(1)
    expect(events.at(-1)!.actor_id).toBe(e.userId)
    expect(s.gmail.calls).toEqual([])
    expect(google.refreshRequests.length).toBe(refreshes)
    expect(await stateRow()).toMatchObject({ run_id: null, lease_until: null })
  })
  it('a role without connections:write is suspended too', async () => {
    const s = await setup()
    s.state.roles.set('user_engine_1', 'member')
    s.state.policy = { ...SCOPE_POLICY, 'connections:write': { member: false, agentGrantable: false } }
    expect((await run(s)).end).toBe('suspended')
    expect((await connection()).status).toBe('suspended')
  })
  it('a role-source failure throws and changes nothing', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    s.state.roleFailure = true
    const before = await snapshot()
    await expect(run(s)).rejects.toThrow('role source down')
    expect(await snapshot()).toEqual(before)
    expect(s.gmail.calls).toEqual([])
  })
  it('a deployment without a role source (no auth provider) admits the owner', async () => {
    const s = await setup({ noProvider: true })
    expect((await run(s)).end).toBe('complete')
  })
  it('a connection that is not active ends the run at claim, writing nothing', async () => {
    const s = await setup()
    await raw("update channel_connections set status = 'reauth_required'")
    const before = await snapshot()
    expect(await run(s)).toEqual({ end: 'inactive', passes: 0 })
    expect(await snapshot()).toEqual(before)
  })
})

describe('gate (D37)', () => {
  it('while behind, the first step throws retryably and writes nothing', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    s.state.behind = true
    const before = await snapshot()
    await expect(run(s)).rejects.toThrow(/behind/)
    expect(await snapshot()).toEqual(before)
  })
  it('the claim step that finds the database behind throws and writes no lease; so does the finish step, stamping nothing', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    const atClaim = makeWorkerdStepShim({ beforeStep: (name) => void (name === 'claim' && (s.state.behind = true)) })
    await expect(run(s, atClaim)).rejects.toThrow(/behind/)
    expect(await stateRow()).toMatchObject({ run_id: null, lease_until: null })
    s.state.behind = false
    const atFinish = makeWorkerdStepShim({ beforeStep: (name) => void (name === 'p1-finish' && (s.state.behind = true)) })
    await expect(run(s, atFinish)).rejects.toThrow(/behind/)
    expect((await stateRow()).last_success_at).toBeNull()
  })
  it('a page step that finds the database behind throws and writes no page', async () => {
    const s = await setup({ messages: [mk('m1')] })
    addHistory(s.gmail, '1001', ['m1'])
    const shim = makeWorkerdStepShim({
      beforeStep: (name) => {
        if (name === 'p1-history-1') s.state.behind = true
      },
    })
    await expect(run(s, shim)).rejects.toThrow(/behind/)
    expect((await e.rows('messages')).length).toBe(0)
    expect((await cursor()).history_id).toBe('1000')
    expect(s.gmail.calls).toEqual([])
  })
})

describe('secrecy', () => {
  it('no access or refresh token in a step return, a row, a log line or an error message across a full run, rotation included', async () => {
    const lines: string[] = []
    for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
    const s = await setup({ messages: [...many(3, 'b'), mk('h1')], synced: null })
    addHistory(s.gmail, '1001', ['h1'])
    s.gmail.profile.historyId = '1002'
    google.rotateRefreshTokens(true)
    const shim = makeWorkerdStepShim()
    await run(s, shim)
    // And a failing run: its error message carries no provider text or token.
    const t = await setup({ messages: [], mailbox: 'second@vault.test', sub: 'sub-second' })
    google.revoke(t.refreshToken)
    const failed = await run(t).catch((err: Error) => err.message)
    const secrets = [s.refreshToken, t.refreshToken, ...google.refreshTokens, ...google.accessTokens, CONFIG.clientSecret]
    const haystack = [JSON.stringify(shim.returns), lines.join('\n'), String(failed), JSON.stringify(await e.rows('mail_sync_state')), JSON.stringify(await e.rows('mail_sync_cursors')), JSON.stringify(await e.rows('events')), JSON.stringify(await e.rows('channel_credentials'))].join('\n')
    for (const secret of secrets) expect(haystack).not.toContain(secret)
    expect(secrets.length).toBeGreaterThan(3)
  })
})
