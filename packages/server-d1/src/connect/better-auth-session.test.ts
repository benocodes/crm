import { describe, expect, it } from 'vitest'
import { betterAuthSession } from './better-auth-session.js'

// [[UI297]] D7, R1-R4: the Better Auth seam's contract on a fake `fetch`.

interface Req {
  method: string
  path: string
  headers: Record<string, string>
  body: string | null
  credentials: string | undefined
}
type Answer = Response | (() => Response) | Error
function fake(script: Record<string, Answer[]>) {
  const seen: Req[] = []
  const used: Record<string, number> = {}
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://w.test')
    const method = init?.method ?? 'GET'
    seen.push({ method, path: url.pathname + url.search, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? init.body : null, credentials: init?.credentials })
    const key = `${method} ${url.pathname}`
    const list = script[key]
    if (!list) return new Response('{}', { status: 599 })
    const i = Math.min(used[key] ?? 0, list.length - 1)
    used[key] = (used[key] ?? 0) + 1
    const a = list[i]!
    if (a instanceof Error) throw a
    return typeof a === 'function' ? a() : a.clone()
  }) as typeof fetch
  return { fetchFn, seen, count: (key: string) => seen.filter((s) => `${s.method} ${s.path}` === key).length }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const SESSION = json({ session: { id: 's' }, user: { id: 'u', email: 'o@x.test' } })
const NULL_SESSION = new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })
const make = (script: Record<string, Answer[]>) => {
  const f = fake(script)
  const navigated: string[] = []
  return { ...f, navigated, seam: betterAuthSession({ fetch: f.fetchFn, navigate: (u) => void navigated.push(u) }) }
}

describe('load (R1)', () => {
  it('a session body is signed in; a 200 with a null body is signed out', async () => {
    const a = make({ 'GET /auth/get-session': [SESSION] })
    await a.seam.load()
    expect(a.seam.isSignedIn()).toBe(true)
    const b = make({ 'GET /auth/get-session': [NULL_SESSION] })
    await b.seam.load()
    expect(b.seam.isSignedIn()).toBe(false)
  })
  it('reads the session same-origin with cookies', async () => {
    const a = make({ 'GET /auth/get-session': [SESSION] })
    await a.seam.load()
    expect(a.seen).toHaveLength(1)
    expect(a.seen[0]!.path).toBe('/auth/get-session')
    expect(a.seen[0]!.credentials ?? 'same-origin').toBe('same-origin')
  })
  it.each([[500], [401], [403]])('a %i rejects', async (status) => {
    const a = make({ 'GET /auth/get-session': [json({}, status)] })
    await expect(a.seam.load()).rejects.toBeTruthy()
  })
  it('a network failure rejects', async () => {
    const a = make({ 'GET /auth/get-session': [new TypeError('offline')] })
    await expect(a.seam.load()).rejects.toBeTruthy()
  })
})

describe('getToken (R2)', () => {
  it('every call is its own /auth/token request, never cached', async () => {
    const a = make({ 'GET /auth/token': [json({ token: 'a.b.c' }), json({ token: 'd.e.f' })] })
    expect(await a.seam.getToken()).toBe('a.b.c')
    expect(await a.seam.getToken()).toBe('d.e.f')
    expect(a.count('GET /auth/token')).toBe(2)
  })
  it('a 401 is null', async () => {
    const a = make({ 'GET /auth/token': [json({}, 401)] })
    expect(await a.seam.getToken()).toBeNull()
  })
  it('any other failure rejects', async () => {
    const a = make({ 'GET /auth/token': [json({}, 500)] })
    await expect(a.seam.getToken()).rejects.toBeTruthy()
    const b = make({ 'GET /auth/token': [new TypeError('offline')] })
    await expect(b.seam.getToken()).rejects.toBeTruthy()
  })
  it('a 200 without a token string is null', async () => {
    const a = make({ 'GET /auth/token': [json({})] })
    expect(await a.seam.getToken()).toBeNull()
  })
})

describe('recheckSession', () => {
  it('re-reads the session each time: true, then false after it ends', async () => {
    const a = make({ 'GET /auth/get-session': [SESSION, SESSION, NULL_SESSION] })
    await a.seam.load()
    expect(await a.seam.recheckSession()).toBe(true)
    expect(await a.seam.recheckSession()).toBe(false)
    expect(a.seam.isSignedIn()).toBe(false)
    expect(a.count('GET /auth/get-session')).toBe(3)
  })
})

describe('redirectToSignIn (R3)', () => {
  it('ignores its argument: exactly /sign-in?return_to=/connect, relative', async () => {
    const a = make({})
    await a.seam.redirectToSignIn('https://evil.example/x')
    expect(a.navigated).toEqual(['/sign-in?return_to=/connect'])
  })
})

describe('signOut (R4)', () => {
  it('POSTs /auth/sign-out same-origin and the seam is signed out afterwards', async () => {
    const a = make({ 'GET /auth/get-session': [SESSION], 'POST /auth/sign-out': [json({ success: true })] })
    await a.seam.load()
    await a.seam.signOut()
    expect(a.seen.filter((s) => s.method === 'POST').map((s) => s.path)).toEqual(['/auth/sign-out'])
    expect(a.seam.isSignedIn()).toBe(false)
  })
  it('a refused sign-out rejects and the seam stays signed in', async () => {
    const a = make({ 'GET /auth/get-session': [SESSION], 'POST /auth/sign-out': [json({}, 403)] })
    await a.seam.load()
    await expect(a.seam.signOut()).rejects.toBeTruthy()
    expect(a.seam.isSignedIn()).toBe(true)
  })
})

describe('profileUrl', () => {
  it('is null', () => {
    expect(make({}).seam.profileUrl()).toBeNull()
  })
})
