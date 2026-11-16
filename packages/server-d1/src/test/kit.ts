// Test support for the D1 Worker package (a `test/` directory: the boundary checker treats it as tests).
import {
  openControlDb,
  readControlMarker,
  writeControlMarker,
  type D1Like,
  type D1PreparedLike,
} from '@vibase/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import {
  mintOAuthToken,
  SECRET_KEY,
  WEBHOOK_SECRET,
  API_URL,
  clerkOrganization,
  clerkMembership,
  clerkUser,
  fakeClerkFetch,
  testIssuer,
  type ClerkMembershipJson,
  type ClerkOrganizationJson,
  type ClerkUserJson,
  type FakeFetch,
  type TestIssuer,
} from '@vibase/api/test/clerk'
import { bootstrapD1 as bootstrapD1Real } from '../bootstrap-d1.js'
import { composeD1Worker as composeRealD1Worker, type D1WorkerEnv } from '../compose.js'

export { clerkOrganization, clerkMembership, clerkUser, mintOAuthToken }
/** For another package's integration test that bootstraps a Better Auth instance (the CLI's `audit` test). */
export { openControlDb } from '@vibase/storage-d1'

export interface WorkerD1 {
  readonly d1: D1Like
  /**
   * The control-plane database ([[CORE326]]: every composition needs one), migrated, and AUTO-PAIRED with `d1`: the first read of its marker, once `d1` holds a deployment row, writes the matching marker.
   * Hand it to the Worker as `CONTROL_DB`, or compose through this kit's `composeD1Worker`, which does it for an env whose `DB` came from here. A test of the pairing itself uses `openWorkerPair` (no auto-pairing).
   */
  readonly control: D1Like
  /** Empties every table, the deployment marker included, and keeps the schema (both databases). */
  reset(): Promise<void>
  dispose(): Promise<void>
}

/** The control database a CRM binding was opened with (and the same for the spying wrappers made from it): what `composeD1Worker` below defaults `CONTROL_DB` to. */
const pairedControl = new WeakMap<object, D1Like>()
/** A wrapper around a CRM binding (a spy, a meter, a fault) is the same database: it keeps the pairing. */
export const inheritPairing = <T extends D1Like>(real: D1Like, wrapper: T): T => {
  const control = pairedControl.get(real)
  if (control) pairedControl.set(wrapper, control)
  return wrapper
}

/** A control database whose marker is written on first read, from `crm`'s deployment row (nothing when there is none yet): the kit's stand-in for what bootstrap writes. */
function autoPairedControl(crm: D1Like, control: D1Like): D1Like {
  const ensure = async () => {
    const link = (await crm
      .prepare('select organization_id from deployment')
      .first()
      .catch(() => null)) as { organization_id: string } | null
    if (!link) return
    const db = openControlDb(control)
    if (!(await readControlMarker(db))) await writeControlMarker(db, link.organization_id)
  }
  // A batch is run by the real handle, which only takes statements it prepared itself (the request transport checks): the wrappers are unwrapped first.
  const inners = new WeakMap<object, D1PreparedLike>()
  const wrap = (q: string, inner: D1PreparedLike): D1PreparedLike => {
    const gate = /control_deployment/.test(q)
    const wrapped = {
      bind: (...v: unknown[]) => wrap(q, inner.bind(...v)),
      run: async () => (gate && (await ensure()), inner.run()),
      all: async () => (gate && (await ensure()), inner.all()),
      first: async () => (gate && (await ensure()), inner.first()),
    } as D1PreparedLike
    inners.set(wrapped, inner)
    return wrapped
  }
  return {
    prepare: (q: string) => wrap(q, control.prepare(q)),
    batch: (b: D1PreparedLike[]) => control.batch(b.map((s) => inners.get(s) ?? s)),
  } as D1Like
}

/**
 * `composeD1Worker` for tests ([[CORE326]]): an env whose `DB` came from `openWorkerD1` (or a spy/meter/fault over it) and names no `CONTROL_DB` gets the auto-paired control database of that `DB`. An env that
 * names `CONTROL_DB` itself, even as `undefined`, is composed as given (the control matrix and the missing-binding rows).
 */
export function composeD1Worker(
  env: D1WorkerEnv,
  deps?: Parameters<typeof composeRealD1Worker>[1],
): ReturnType<typeof composeRealD1Worker> {
  const control = 'CONTROL_DB' in env ? undefined : pairedControl.get(env.DB)
  return composeRealD1Worker(control ? { ...env, CONTROL_DB: control } : env, deps)
}

/**
 * A control database whose `control_audit` inserts do nothing, for a suite that bootstraps a real key through `bootstrapD1` but pins an empty or exact audit log ([[CORE356]]: bootstrap now writes an `api_key.created` row, and
 * `control_audit` is append-only, so the row cannot be deleted after). Everything else is the real database.
 */
export function unauditedControl(control: D1Like): D1Like {
  const inners = new WeakMap<object, D1PreparedLike>()
  const noop = (): D1PreparedLike => {
    const real = control.prepare('select 1')
    const stub = {
      bind: () => stub,
      run: () => real.run(),
      all: () => real.all(),
      first: () => real.first(),
    } as D1PreparedLike
    inners.set(stub, real)
    return stub
  }
  const wrap = (inner: D1PreparedLike): D1PreparedLike => {
    const w = {
      bind: (...v: unknown[]) => wrap(inner.bind(...v)),
      run: () => inner.run(),
      all: () => inner.all(),
      first: () => inner.first(),
    } as D1PreparedLike
    inners.set(w, inner)
    return w
  }
  return {
    prepare: (q: string) => (/^\s*insert into control_audit/i.test(q) ? noop() : wrap(control.prepare(q))),
    batch: (b: D1PreparedLike[]) => control.batch(b.map((s) => inners.get(s) ?? s)),
  } as D1Like
}

/**
 * `bootstrapD1` for tests ([[CORE356]] P5): a CRM binding from `openWorkerD1` (or a spy over it) has a paired control database, and a key is minted there, so the call gets it as `control` unless the test passes one
 * (or `control: undefined` through a rest of its own: the missing-control rows call the real function). The call shape is the real function's.
 */
export const bootstrapD1: typeof bootstrapD1Real = ((d1: D1Like, opts: never, env: Record<string, unknown> = {}) => {
  const paired = pairedControl.get(d1)
  return bootstrapD1Real(d1, opts, { ...(paired ? { control: openControlDb(paired) } : {}), ...env })
}) as never

/** One migrated in-memory Miniflare D1 for a test file, with its auto-paired control-plane database. */
export async function openWorkerD1(): Promise<WorkerD1> {
  const local: LocalD1 = await openLocalD1(['W', 'C'], { control: ['C'] })
  const d1 = local.bindings.W!
  const control = autoPairedControl(d1, local.bindings.C!)
  pairedControl.set(d1, control)
  return {
    d1,
    control,
    reset: async () => (await clearD1(d1), await clearD1(local.bindings.C!)),
    dispose: () => local.dispose(),
  }
}

/** The CRM database and the control-plane database with NO auto-pairing: for the tests of the pairing and of the control plane itself. */
export interface WorkerPair {
  readonly d1: D1Like
  /** The control-plane database (`CONTROL_DB`, [[CORE259]]), migrated from `control-migrations/` with its own `d1_migrations` tracker. */
  readonly control: D1Like
  reset(): Promise<void>
  dispose(): Promise<void>
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
export function spyD1(
  real: D1Like,
  opts: { failSelectOne?: () => boolean } = {},
): { d1: D1Like; log: SqlLog; betweenPlanAndCommit(hook: () => Promise<void>): void } {
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
  return {
    d1: inheritPairing(real, d1),
    log: { statements, clear: () => void (statements.length = 0) },
    betweenPlanAndCommit: (hook) => void (pending.hook = hook),
  }
}

/**
 * A D1Like that watches the batches sent to `real` ([[CORE288]]): when a batch holds a statement whose SQL matches `match`, `act` runs first, once (`times`, default 1) or on every match
 * (`times: Infinity`). `act` may throw (a failing store) or write through the real database (a change between plan and commit). Reads outside batches pass untouched.
 */
export function faultD1(
  real: D1Like,
  rule: { match: RegExp; act: () => Promise<void>; times?: number },
): { d1: D1Like; fired(): number } {
  // Each wrapper remembers its SQL and the real statement behind it; `batch` hands the real ones on.
  const info = new WeakMap<object, { sql: string; real: D1PreparedLike }>()
  let fired = 0
  const wrap = (sql: string, inner: D1PreparedLike): D1PreparedLike => {
    const w = {
      bind: (...values: unknown[]) => wrap(sql, inner.bind(...values)),
      run: () => inner.run(),
      all: () => inner.all(),
      first: () => inner.first(),
    } as D1PreparedLike
    info.set(w, { sql, real: inner })
    return w
  }
  const d1: D1Like = {
    prepare: (query: string) => wrap(query, real.prepare(query)),
    async batch(batch: D1PreparedLike[]) {
      if (fired < (rule.times ?? 1) && batch.some((s) => rule.match.test(info.get(s)?.sql ?? ''))) {
        fired++
        await rule.act()
      }
      return real.batch(batch.map((s) => info.get(s)?.real ?? s))
    },
  }
  return { d1: inheritPairing(real, d1), fired: () => fired }
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

const zeroMeasure = (): InvocationMeasure => ({
  queries: 0,
  statements: 0,
  maxStatementBytes: 0,
  maxParameters: 0,
  maxBoundTextBytes: 0,
  rowsRead: 0,
  rowsWritten: 0,
  d1DurationMs: 0,
})

/** A D1Like that counts what one invocation sends to D1 (CORE47 P6): queries, statement sizes, bound values, and `meta`. */
export function meterD1(real: D1Like): D1Meter {
  const enc = new TextEncoder()
  let m = zeroMeasure()
  const info = new WeakMap<object, { sql: string; params: unknown[]; real: D1PreparedLike }>()
  const note = (sqlText: string, params: unknown[]) => {
    m.statements++
    m.maxStatementBytes = Math.max(m.maxStatementBytes, enc.encode(sqlText).length)
    m.maxParameters = Math.max(m.maxParameters, params.length)
    for (const p of params)
      if (typeof p === 'string') m.maxBoundTextBytes = Math.max(m.maxBoundTextBytes, enc.encode(p).length)
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
    d1: inheritPairing(real, d1),
    start: () => void (m = zeroMeasure()),
    take: () => {
      const out = m
      m = zeroMeasure()
      return out
    },
  }
}
