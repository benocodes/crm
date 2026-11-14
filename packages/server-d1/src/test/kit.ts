// Test support for the D1 Worker package (a `test/` directory: the boundary checker treats it as tests).
import { type D1Like, type D1PreparedLike } from '@vibase/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { mintOAuthToken, SECRET_KEY, WEBHOOK_SECRET, API_URL, clerkOrganization, clerkMembership, clerkUser, fakeClerkFetch, testIssuer, type ClerkMembershipJson, type ClerkOrganizationJson, type ClerkUserJson, type FakeFetch, type TestIssuer } from '@vibase/api/test/clerk'
import type { D1WorkerEnv } from '../compose.js'

export { clerkOrganization, clerkMembership, clerkUser, mintOAuthToken }

export interface WorkerD1 {
  readonly d1: D1Like
  /** Empties every table, the deployment marker included, and keeps the schema. */
  reset(): Promise<void>
  dispose(): Promise<void>
}

/** One migrated in-memory Miniflare D1 for a test file. */
export async function openWorkerD1(): Promise<WorkerD1> {
  const local: LocalD1 = await openLocalD1(['W'])
  const d1 = local.bindings.W!
  return { d1, reset: () => clearD1(d1), dispose: () => local.dispose() }
}

export interface WorkerPair extends WorkerD1 {
  /** The control-plane database (`CONTROL_DB`, [[CORE259]]), migrated from `control-migrations/` with its own `d1_migrations` tracker. */
  readonly control: D1Like
}

/** Two migrated in-memory Miniflare D1s for a test file: the CRM database and the control-plane database, each from its own directory. `reset()` empties both (trackers kept). */
export async function openWorkerPair(): Promise<WorkerPair> {
  const local: LocalD1 = await openLocalD1(['W', 'C'], { control: ['C'] })
  const d1 = local.bindings.W!
  const control = local.bindings.C!
  return { d1, control, reset: async () => (await clearD1(d1), await clearD1(control)), dispose: () => local.dispose() }
}

export interface SqlLog {
  readonly statements: string[]
  clear(): void
}

/**
 * A D1Like that records the SQL of every prepared statement and optionally pauses between a unit's plan reads and its
 * commit batch to run a hook (deterministic drift, as `api/src/test/engines.ts` does for the engine harness).
 */
export function spyD1(real: D1Like, opts: { failSelectOne?: () => boolean } = {}): { d1: D1Like; log: SqlLog; betweenPlanAndCommit(hook: () => Promise<void>): void } {
  const statements: string[] = []
  const pending: { hook: (() => Promise<void>) | null } = { hook: null }
  const sqlOf = new WeakMap<object, string>()
  const isRead = (s: D1PreparedLike) => /^\s*select\b/i.test(sqlOf.get(s) ?? '')
  const d1: D1Like = {
    prepare(query: string) {
      if (opts.failSelectOne?.() && /^\s*select 1\s*$/i.test(query)) throw new Error('D1 is unavailable')
      statements.push(query)
      const p = real.prepare(query)
      return {
        bind: (...values: unknown[]) => {
          const bound = p.bind(...values)
          sqlOf.set(bound, query)
          return bound
        },
        run: () => p.run(),
        all: () => p.all(),
        first: () => p.first(),
      } as D1PreparedLike
    },
    async batch(batch: D1PreparedLike[]) {
      const reads = batch.length > 0 && batch.every(isRead)
      const hook = pending.hook
      if (hook && !reads) {
        pending.hook = null
        await hook()
        return real.batch(batch)
      }
      const out = await real.batch(batch)
      if (hook && reads) {
        pending.hook = null
        await hook()
      }
      return out
    },
  }
  return { d1, log: { statements, clear: () => void (statements.length = 0) }, betweenPlanAndCommit: (hook) => void (pending.hook = hook) }
}

/**
 * A D1Like that watches the batches sent to `real` ([[CORE288]]): when a batch holds a statement whose SQL matches `match`, `act` runs first, once (`times`, default 1) or on every match
 * (`times: Infinity`). `act` may throw (a failing store) or write through the real database (a change between plan and commit). Reads outside batches pass untouched.
 */
export function faultD1(real: D1Like, rule: { match: RegExp; act: () => Promise<void>; times?: number }): { d1: D1Like; fired(): number } {
  const sqlOf = new WeakMap<object, string>()
  let fired = 0
  const d1: D1Like = {
    prepare(query: string) {
      // The real statement itself is returned (batch needs it), with `bind` wrapped so a bound copy is attributed to its SQL too.
      const p = real.prepare(query)
      sqlOf.set(p, query)
      const bind = p.bind.bind(p)
      p.bind = (...values: unknown[]) => {
        const bound = bind(...values)
        sqlOf.set(bound, query)
        return bound
      }
      return p
    },
    async batch(batch: D1PreparedLike[]) {
      if (fired < (rule.times ?? 1) && batch.some((s) => rule.match.test(sqlOf.get(s) ?? ''))) {
        fired++
        await rule.act()
      }
      return real.batch(batch)
    },
  }
  return { d1, fired: () => fired }
}

export interface ClerkKit {
  issuer: TestIssuer
  fetch: FakeFetch
  profiles: Map<string, ClerkUserJson>
  organizations: Map<string, ClerkOrganizationJson>
  members: Map<string, ClerkMembershipJson[]>
  /** OAuth applications the fake Backend API knows: client id -> name. */
  clients: Map<string, string>
  /** The Worker's Clerk variables, pointing at the local fake. */
  env: Omit<D1WorkerEnv, 'DB'>
}

export async function clerkKit(): Promise<ClerkKit> {
  const issuer = await testIssuer()
  const profiles = new Map<string, ClerkUserJson>()
  const organizations = new Map<string, ClerkOrganizationJson>()
  const members = new Map<string, ClerkMembershipJson[]>()
  const clients = new Map<string, string>()
  return {
    issuer,
    fetch: fakeClerkFetch(profiles, { organizations, members, clients }),
    profiles,
    organizations,
    members,
    clients,
    env: {
      AUTH_PROVIDER: 'clerk',
      CLERK_JWT_KEY: issuer.pem,
      CLERK_ISSUER: issuer.issuer,
      CLERK_AUTHORIZED_PARTIES: issuer.party,
      CLERK_SECRET_KEY: SECRET_KEY,
      CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET,
      CLERK_API_URL: API_URL,
    },
  }
}

export const NOW = new Date('2026-10-27T10:00:00.000Z')
let counter = 0
/** Deterministic UUID-shaped ids, unique within the process. */
export const testId = () => `0190b2c4-0000-7000-8000-${String(++counter).padStart(12, '0')}`

export interface InvocationMeasure {
  /** D1 round trips: batch() = 1, run()/all()/first() = 1 (CORE47 P7, Cloudflare's documented rule). */
  queries: number
  /** Statements inside batches plus single calls. */
  statements: number
  /** UTF-8 bytes of the longest SQL text. */
  maxStatementBytes: number
  maxParameters: number
  /** UTF-8 bytes of the longest bound text value. */
  maxBoundTextBytes: number
  /** Sums of `meta`; 0 when the binding reports none. */
  rowsRead: number
  rowsWritten: number
  d1DurationMs: number
}

export interface D1Meter {
  readonly d1: D1Like
  /** Starts a new invocation window; `take()` returns and closes it. */
  start(): void
  take(): InvocationMeasure
}

const zeroMeasure = (): InvocationMeasure => ({ queries: 0, statements: 0, maxStatementBytes: 0, maxParameters: 0, maxBoundTextBytes: 0, rowsRead: 0, rowsWritten: 0, d1DurationMs: 0 })

/** A D1Like that counts what one invocation sends to D1 (CORE47 P6): queries, statement sizes, bound values, and `meta`. */
export function meterD1(real: D1Like): D1Meter {
  const enc = new TextEncoder()
  let m = zeroMeasure()
  const info = new WeakMap<object, { sql: string; params: unknown[]; real: D1PreparedLike }>()
  const note = (sqlText: string, params: unknown[]) => {
    m.statements++
    m.maxStatementBytes = Math.max(m.maxStatementBytes, enc.encode(sqlText).length)
    m.maxParameters = Math.max(m.maxParameters, params.length)
    for (const p of params) if (typeof p === 'string') m.maxBoundTextBytes = Math.max(m.maxBoundTextBytes, enc.encode(p).length)
  }
  const meta = (r: { meta?: { rows_read?: number; rows_written?: number; duration?: number } } | null | undefined) => {
    m.rowsRead += r?.meta?.rows_read ?? 0
    m.rowsWritten += r?.meta?.rows_written ?? 0
    m.d1DurationMs += r?.meta?.duration ?? 0
  }
  const wrap = (sqlText: string, params: unknown[], inner: D1PreparedLike): D1PreparedLike => {
    const w: D1PreparedLike = {
      bind: (...values: unknown[]) => wrap(sqlText, values, inner.bind(...values)),
      async run() {
        m.queries++
        note(sqlText, params)
        const r = await inner.run()
        meta(r)
        return r
      },
      async all() {
        m.queries++
        note(sqlText, params)
        const r = await inner.all()
        meta(r)
        return r
      },
      async first() {
        m.queries++
        note(sqlText, params)
        return inner.first()
      },
    }
    info.set(w, { sql: sqlText, params, real: inner })
    return w
  }
  const d1: D1Like = {
    prepare: (query: string) => wrap(query, [], real.prepare(query)),
    async batch(statements: D1PreparedLike[]) {
      m.queries++
      for (const s of statements) {
        const i = info.get(s)
        if (i) note(i.sql, i.params)
      }
      const results = await real.batch(statements.map((s) => info.get(s)?.real ?? s))
      for (const r of results) meta(r)
      return results
    },
  }
  return {
    d1,
    start: () => void (m = zeroMeasure()),
    take: () => {
      const out = m
      m = zeroMeasure()
      return out
    },
  }
}
