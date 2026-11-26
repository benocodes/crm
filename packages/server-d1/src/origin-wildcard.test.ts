import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS } from '@vibase/storage-d1'
import type { D1WorkerEnv } from './compose.js'
import { earlyAnswer } from './early.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { bootstrapD1, composeD1Worker, NOW, openWorkerD1, type WorkerD1 } from './test/kit.js'

// [[API622]] D3, D4, group 3: every consumer of either origin var matches through `originMatches`. Rows: the REST `cors` answer and preflight, the `/mcp` Origin rule in the Hono app, the same rule in early.ts, the
// credentialed `/auth` branch. Columns: an origin only a wildcard matches (allowed, echoed with `Vary: Origin`) and the zone's bare host (refused, or no CORS header, as each surface does today).
let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
}, 60_000)
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(
    w.d1,
    MIGRATIONS.map((m) => m.name),
  )
  await bootstrapD1(w.d1, { organizationName: 'Acme', authOrgId: 'org_wild' }, { now: NOW, newId: () => uuidv7(NOW) })
})

const MATCHED = 'https://a.b.zone.example.com' // depth 2, through the wildcard only
const BARE = 'https://zone.example.com'
const env = (over: Partial<D1WorkerEnv> = {}): D1WorkerEnv =>
  ({
    DB: w.d1,
    CONTROL_DB: w.control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
    CORS_ALLOWED_ORIGINS: 'https://*.zone.example.com',
    AUTH_TRUSTED_ORIGINS: 'https://*.zone.example.com',
    ...over,
  }) as D1WorkerEnv
const call = (path: string, init: RequestInit) => composeD1Worker(env()).fetch(new Request(AUTH_BASE + path, init))
const preflight = (path: string, origin: string) =>
  call(path, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
  })

describe('REST cors (answer and preflight)', () => {
  it('a wildcard-matched origin gets its own Origin echoed with Vary: Origin; the bare host gets no CORS header', async () => {
    const pre = await preflight('/api/v1/contacts', MATCHED)
    expect(pre.headers.get('access-control-allow-origin')).toBe(MATCHED)
    expect(pre.headers.get('vary')).toMatch(/origin/i)
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull()
    const answer = await call('/api/v1/contacts', { headers: { origin: MATCHED } })
    expect(answer.headers.get('access-control-allow-origin')).toBe(MATCHED)
    expect(answer.headers.get('vary')).toMatch(/origin/i)
    const bare = await preflight('/api/v1/contacts', BARE)
    expect(bare.headers.get('access-control-allow-origin')).toBeNull()
    expect((await call('/api/v1/contacts', { headers: { origin: BARE } })).headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('the /mcp Origin rule in the Hono app (a request with a credential goes the full way)', () => {
  const mcp = (origin: string) =>
    call('/mcp', {
      method: 'POST',
      headers: { origin, authorization: 'Bearer vk_nothing', 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    })
  it('a wildcard-matched origin passes the rule (401 for the bad credential, with its CORS echo); the bare host is 403 origin_forbidden', async () => {
    const ok = await mcp(MATCHED)
    expect(ok.status).toBe(401)
    expect(ok.headers.get('access-control-allow-origin')).toBe(MATCHED)
    const bare = await mcp(BARE)
    expect(bare.status).toBe(403)
    expect(((await bare.json()) as { error: { code: string } }).error.code).toBe('origin_forbidden')
  })
})

describe('the /mcp Origin rule in early.ts', () => {
  const early = (origin: string) =>
    earlyAnswer(
      new Request(AUTH_BASE + '/mcp', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      }),
      env(),
    )
  it('a wildcard-matched origin gets the 401 challenge with its echo and Vary; the bare host is 403', async () => {
    const ok = early(MATCHED)
    expect(ok?.status).toBe(401)
    expect(ok?.headers.get('access-control-allow-origin')).toBe(MATCHED)
    expect(ok?.headers.get('vary')).toBe('Origin')
    const bare = early(BARE)
    expect(bare?.status).toBe(403)
    expect(bare?.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('a malformed wildcard defers to the full path (undefined), as any malformed entry does', () => {
    const bad = earlyAnswer(
      new Request(AUTH_BASE + '/mcp', { method: 'POST', headers: { origin: MATCHED } }),
      env({ CORS_ALLOWED_ORIGINS: 'https://foo*.example.com' }),
    )
    expect(bad).toBeUndefined()
  })
})

describe('the credentialed /auth branch (UI255 D7)', () => {
  const pre = (origin: string) =>
    call('/auth/sign-out', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
  it('a wildcard-matched trusted origin gets the credentialed answer with its own Origin; the bare host gets none', async () => {
    const ok = await pre(MATCHED)
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe(MATCHED)
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true')
    expect(ok.headers.get('vary')).toMatch(/origin/i)
    const bare = await pre(BARE)
    expect(bare.headers.get('access-control-allow-origin')).toBeNull()
    expect(bare.headers.get('access-control-allow-credentials')).toBeNull()
  })
})
