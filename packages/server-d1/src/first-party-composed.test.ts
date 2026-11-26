import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, createOAuthClient, deleteOAuthClient, openControlDb, updateOAuthClient } from '@vibase/storage-d1'
import type { D1Like, D1PreparedLike } from '@vibase/storage-d1'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVibaseRegistry } from '@vibase/api'
import { resourcesFor } from '@vibase/auth'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { bootstrapD1, inheritPairing, NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE639]] groups 1, 3 and 5 through the Node composition: the REAL Better Auth mints an access token for a first-party client (authorization code with PKCE, no consent), and the composed Worker
// (`composeD1Worker`, `better-auth`) reads that client through the control store: the token is the person (D2), a scopes edit and a delete reach it after the minute on the Worker's own clock (D5, D6),
// and a failing client read is a 500 that is not cached (P1).
let w: WorkerPair
let kit: AuthKit
let orgId: string
let bootUser: string
const declared = createVibaseRegistry().declaredScopes()
const REDIRECT = 'https://app.test/cb'
const verifier = 'v'.repeat(60)
const challenge = createHash('sha256').update(verifier).digest('base64url')
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(
    w.d1,
    MIGRATIONS.map((m) => m.name),
  )
  const r = await bootstrapD1(
    w.d1,
    { organizationName: 'Acme', email: 'boot@x.test', agentName: 'bot', authProvider: 'none', authOrgId: 'org_acme' },
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) },
  )
  orgId = r.organizationId
  bootUser = r.userId!
  kit = authKit(w.control, { scopes: declared })
})

/** The control database with a switch: while `failing`, a read of `auth_oauth_clients` by client id throws. */
function flakyControl(real: D1Like) {
  const state = { failing: false, reads: 0 }
  const wrap = (sql: string, inner: D1PreparedLike): D1PreparedLike =>
    ({
      bind: (...v: unknown[]) => wrap(sql, inner.bind(...v)),
      run: () => inner.run(),
      all: () => inner.all(),
      first: () => {
        if (/from auth_oauth_clients where client_id = \?$/.test(sql.trim())) {
          state.reads++
          if (state.failing) throw new Error('control database unavailable')
        }
        return inner.first()
      },
    }) as D1PreparedLike
  const d1: D1Like = { prepare: (q: string) => wrap(q, real.prepare(q)), batch: (b: D1PreparedLike[]) => real.batch(b) }
  return { d1: inheritPairing(real, d1), state }
}

const call = async (wk: ReturnType<typeof composeD1Worker>, path: string, tok: string, init: RequestInit = {}) => {
  const res = await wk.fetch(
    new Request(AUTH_BASE + path, { ...init, headers: { authorization: `Bearer ${tok}`, ...(init.headers ?? {}) } }),
  )
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const count = async (t: string) =>
  Number(((await w.d1.prepare(`select count(*) n from "${t}"`).first()) as { n: number }).n)

async function owner() {
  const { userId, cookie } = await kit.signUp('owner@x.test')
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, {
    id,
    kind: 'user',
    email: 'owner@x.test',
    authProvider: 'better-auth',
    authSubject: userId,
  })
  await seedMembership(w.d1, { organizationId: orgId, userId: id, role: 'owner' })
  return { id, cookie }
}
const firstParty = (scopes: string[] | null) =>
  createOAuthClient(openControlDb(w.control), {
    organizationId: orgId,
    clientId: `app_${uuidv7(NOW).slice(-20)}`,
    name: 'Deals board',
    redirectUris: [REDIRECT],
    scopes,
    skipConsent: true,
    resources: resourcesFor(AUTH_BASE),
    actorId: bootUser,
    now: new Date().toISOString(),
    newId: () => uuidv7(NOW),
  }) as Promise<{ clientId: string }>
/** Authorization code with PKCE for a signed-in cookie: a consent-free client goes straight to the redirect URI with a code. */
async function accessToken(cookie: string, clientId: string, scope = 'openid contacts:read'): Promise<string> {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: 's1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: AUTH_BASE,
  })
  const a = await kit.call(`/auth/oauth2/authorize?${q}`, { cookie })
  const text = await a.text()
  const location = a.headers.get('location') ?? (JSON.parse(text) as { url?: string }).url
  const code = new URL(location!, AUTH_BASE).searchParams.get('code')
  expect(code, `authorize answered ${a.status} ${text}`).toBeTruthy()
  const t = await kit.call('/auth/oauth2/token', {
    form: true,
    body: {
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
      resource: AUTH_BASE,
    },
  })
  const body = (await t.json()) as { access_token: string }
  expect(t.status, JSON.stringify(body)).toBe(200)
  return body.access_token
}
const env = (control: D1WorkerEnv['CONTROL_DB']): D1WorkerEnv => ({
  DB: w.d1,
  CONTROL_DB: control,
  AUTH_PROVIDER: 'better-auth',
  AUTH_SECRET,
  PUBLIC_BASE_URL: AUTH_BASE,
})
/** A Worker whose clock is `clock.now` (tokens are minted at the real time, so it starts there). */
const timed = (control: D1WorkerEnv['CONTROL_DB']) => {
  const clock = { now: Date.now() }
  const wk = composeD1Worker(env(control), { clock: () => new Date(clock.now), nowMs: () => clock.now })
  return { wk, clock }
}

describe('a first-party token through the composed Worker', () => {
  it('is the owner as a user (client named, role owner), holds every ceiling scope though it asked for contacts:read only, and a write is attributed to the person with no agent written', async () => {
    const o = await owner()
    const app = await firstParty(null)
    const tok = await accessToken(o.cookie, app.clientId)
    const { wk } = timed(w.control)
    const me = await call(wk, '/meta/v1/me', tok)
    expect(me.status, JSON.stringify(me.json)).toBe(200)
    expect(me.json.principal).toMatchObject({ kind: 'user', id: o.id })
    expect(me.json.client_id).toBe(app.clientId)
    expect(me.json.active_organization.scopes).toContain('deals:write')
    expect(me.json.active_organization.scopes).not.toContain('oauth_clients:write')
    const wrote = await call(wk, '/api/v1/contacts', tok, {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(wrote.status, JSON.stringify(wrote.json)).toBe(201)
    const events = await w.d1.prepare("select actor_id from events where type = 'contact.created'").all()
    expect(events.results).toEqual([{ actor_id: o.id }])
    expect(await count('agents')).toBe(1) // the bootstrap agent only
    expect(
      (await w.d1.prepare("select id from events where type = 'agent.created' and actor_id = ?").bind(o.id).all())
        .results,
    ).toEqual([])
  })

  it('a scopes edit reaches the live token on the Worker clock: old bound at +59 s, new at +61 s; a delete is 401 at +61 s with nothing written', async () => {
    const o = await owner()
    const app = await firstParty(null)
    const tok = await accessToken(o.cookie, app.clientId)
    const { wk, clock } = timed(w.control)
    const scopesOf = async () =>
      (await call(wk, '/meta/v1/me', tok)).json?.active_organization?.scopes as string[] | undefined
    expect(await scopesOf()).toContain('deals:write')
    await updateOAuthClient(openControlDb(w.control), {
      organizationId: orgId,
      clientId: app.clientId,
      actorId: bootUser,
      now: new Date().toISOString(),
      newId: () => uuidv7(NOW),
      scopes: ['contacts:read'],
    })
    clock.now += 59_000
    expect(await scopesOf()).toContain('deals:write')
    clock.now += 2_000
    expect(await scopesOf()).toEqual(['contacts:read'])
    await deleteOAuthClient(openControlDb(w.control), {
      organizationId: orgId,
      clientId: app.clientId,
      actorId: bootUser,
      now: new Date().toISOString(),
      newId: () => uuidv7(NOW),
    })
    clock.now += 59_000
    expect((await call(wk, '/meta/v1/me', tok)).status).toBe(200)
    const agentsBefore = await count('agents')
    clock.now += 2_000
    const gone = await call(wk, '/meta/v1/me', tok)
    expect(gone.status).toBe(401)
    expect(gone.json.error.code).toBe('unauthenticated')
    expect(await count('agents')).toBe(agentsBefore)
  })

  it('a failing client read is 500 internal and is not cached: the next request reads again and is served', async () => {
    const o = await owner()
    const app = await firstParty(null)
    const tok = await accessToken(o.cookie, app.clientId)
    const flaky = flakyControl(w.control)
    const { wk } = timed(flaky.d1)
    flaky.state.failing = true
    const before = flaky.state.reads
    const failed = await call(wk, '/meta/v1/me', tok)
    expect(failed.status).toBe(500)
    expect(failed.json.error.code).toBe('internal')
    flaky.state.failing = false
    expect((await call(wk, '/meta/v1/me', tok)).status).toBe(200)
    expect(flaky.state.reads).toBeGreaterThan(before + 1)
    const reads = flaky.state.reads
    expect((await call(wk, '/meta/v1/me', tok)).status).toBe(200)
    expect(flaky.state.reads).toBe(reads)
  })
})
