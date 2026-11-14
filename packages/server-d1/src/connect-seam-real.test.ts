import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVibaseRegistry } from '@vibase/api'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { createApi } from './connect/api.js'
import { betterAuthSession } from './connect/better-auth-session.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[UI297]] D7 against the real handler: the seam's own code, over a `fetch` bound to the composed Worker (a cookie jar and the page origin), shows the shapes the fake `fetch` of better-auth-session.test.ts assumes.
let w: WorkerPair
let kit: AuthKit
let orgId: string
const declared = createVibaseRegistry().declaredScopes()
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name))
  const r = await bootstrapD1(w.d1, { organizationName: 'Acme', email: 'boot@x.test', agentName: 'bot', authProvider: 'none', authOrgId: 'org_acme' }, { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) })
  orgId = r.organizationId
  kit = authKit(w.control, { scopes: declared })
})

const env = (): D1WorkerEnv => ({ DB: w.d1, CONTROL_DB: w.control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET, PUBLIC_BASE_URL: AUTH_BASE })

/** What a browser does for the page: relative URLs resolve against the page origin, the origin header is sent, `Set-Cookie` is kept. */
function browser(cookie: string) {
  const worker = composeD1Worker(env())
  const jar = new Map<string, string>()
  const [name, value] = cookie.split('=')
  jar.set(name!, value!)
  const requests: string[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, AUTH_BASE)
    const headers = new Headers(init?.headers)
    headers.set('origin', AUTH_BASE)
    if (url.origin === AUTH_BASE && init?.credentials !== 'omit' && jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    const res = await worker.fetch(new Request(url, { ...init, headers }))
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';')
      const [k, v] = pair!.split('=')
      if (v === '' || attrs.some((a) => /^\s*max-age=0/i.test(a))) jar.delete(k!)
      else jar.set(k!, v!)
    }
    return res
  }) as typeof fetch
  return { fetchFn, requests, jar }
}

async function person() {
  const { userId, cookie } = await kit.signUp('person@x.test')
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, { id, kind: 'user', email: 'person@x.test', authProvider: 'better-auth', authSubject: userId })
  await seedMembership(w.d1, { organizationId: orgId, userId: id, role: 'owner' })
  return { cookie, id }
}

describe('the Better Auth seam against the composed Worker', () => {
  it('signed in: load sees the session, getToken is a JWT the API accepts (me, agents), sign-out ends it, signed out getToken is null', async () => {
    const { cookie, id } = await person()
    const b = browser(cookie)
    const seam = betterAuthSession({ fetch: b.fetchFn })
    await seam.load()
    expect(seam.isSignedIn()).toBe(true)

    const t1 = await seam.getToken()
    const t2 = await seam.getToken()
    expect(t1).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
    expect(t2).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
    expect(b.requests.filter((r) => r === 'GET /auth/token')).toHaveLength(2)

    const api = createApi({ origin: AUTH_BASE, getToken: () => seam.getToken(), fetch: b.fetchFn })
    const me = await api.me()
    expect(me.status).toBe(200)
    expect(me.body?.user?.email).toBe('person@x.test')
    expect(me.body?.principal.id).toBe(id)
    const agents = await api.agents()
    expect(agents.status).toBe(200)
    expect(Array.isArray(agents.body)).toBe(true)

    expect(await seam.recheckSession()).toBe(true)
    await seam.signOut()
    expect(seam.isSignedIn()).toBe(false)
    expect(await seam.recheckSession()).toBe(false)
    await seam.load()
    expect(seam.isSignedIn()).toBe(false)
    expect(await seam.getToken()).toBeNull()
  })

  it('a person with no session: load is signed out (200, null) and getToken is null', async () => {
    const b = browser('x=y')
    b.jar.clear()
    const seam = betterAuthSession({ fetch: b.fetchFn })
    await seam.load()
    expect(seam.isSignedIn()).toBe(false)
    expect(await seam.getToken()).toBeNull()
  })
})
