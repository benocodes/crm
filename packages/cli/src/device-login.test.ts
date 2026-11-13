import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { wellKnown } from './test/fixtures.js'
import { fakeIssuer, network, type FakeIssuerOptions } from './test/fake-issuer.js'
import { fakeInstance, json, KEY, rig } from './test/harness.js'

// [[API104]] ([[API6]] D11, D18-D21): device login, refresh, the lock and logout against a fake authorization server
// (RFC 8414, 8628, 6749 refresh with rotating refresh tokens, 7009) and a fake instance. The D1 app is device-login.integration.test.ts.

const SERVER = 'https://vibase.test'
const SCOPES = ['contacts:read', 'contacts:write', 'tasks:read']
const ME = { principal: { id: 'p1', kind: 'user' }, user: { id: 'p1' }, active_organization: { id: 'o1', role: 'owner', scopes: ['contacts:read'] } }

const rigs: ReturnType<typeof rig>[] = []
const worlds: World[] = []
afterEach(() => {
  // The shared assertion, automatic: nothing the authorization server issued is in any run's stdout or stderr.
  try {
    for (const w of worlds) for (const o of w.r.outputs) for (const s of w.iss.secrets()) {
      expect(o.stdout, `stdout of vibase ${o.argv.join(' ')}`).not.toContain(s)
      expect(o.stderr, `stderr of vibase ${o.argv.join(' ')}`).not.toContain(s)
    }
  } finally {
    worlds.length = 0
    while (rigs.length) rigs.pop()!.dispose()
  }
})

interface World {
  iss: ReturnType<typeof fakeIssuer>
  net: ReturnType<typeof network>
  r: ReturnType<typeof rig>
  denyAll: boolean
  meRedirect?: string
  /** The second page of /api/v1/widgets answers 401. */
  denyPage2?: boolean
}

function world(o: { issuer?: FakeIssuerOptions; auth?: unknown | ((issuer: string, origin: string) => unknown); scopes?: string[] | null } = {}): World {
  const iss = fakeIssuer(o.issuer)
  const w = { denyAll: false } as World
  const inst = fakeInstance({
    wellKnown: (origin) =>
      wellKnown(origin, {
        auth:
          typeof o.auth === 'function'
            ? o.auth(iss.origin, origin)
            : o.auth !== undefined
              ? o.auth
              : { provider: 'clerk', issuer: iss.origin, cli_client_id: iss.clientId, protected_resource_metadata: origin + '/.well-known/oauth-protected-resource' },
      }),
    routes: (req) => {
      const u = new URL(req.url)
      if (u.pathname === '/.well-known/oauth-protected-resource') return json({ resource: u.origin, authorization_servers: [iss.origin], scopes_supported: o.scopes ?? SCOPES, bearer_methods_supported: ['header'] })
      if (u.pathname === '/meta/v1/me' || u.pathname === '/api/v1/widgets') {
        if (w.meRedirect && u.pathname === '/meta/v1/me') return new Response(null, { status: 307, headers: { location: w.meRedirect } })
        const tok = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
        if (w.denyAll || !tok || !iss.isLiveAccess(tok)) return json({ error: { code: 'unauthorized', message: 'bad token' } }, 401)
        if (u.pathname === '/api/v1/widgets' && w.denyPage2) {
          if (u.searchParams.has('after')) return json({ error: { code: 'unauthorized', message: 'bad token' } }, 401)
          return json({ data: [{ id: '00000000-0000-7000-8000-000000000009', name: 'a' }], next_cursor: '00000000-0000-7000-8000-000000000009' })
        }
        return json(u.pathname === '/meta/v1/me' ? ME : { data: [], next_cursor: null })
      }
      return undefined
    },
  })
  w.iss = iss
  w.net = network({ [SERVER]: inst.fetch, [iss.origin]: iss.handler, 'https://evil.test': () => json({ stolen: true }) })
  w.r = rig({ fetch: w.net.fetch })
  rigs.push(w.r)
  worlds.push(w)
  return w
}

const cfg = (w: World) => JSON.parse(readFileSync(w.r.configFile, 'utf8'))
const profile = (w: World, name = 'default') => cfg(w).profiles[name]
const writeCfg = (w: World, c: unknown) => {
  writeFileSync(w.r.configFile, JSON.stringify(c, null, 2))
  chmodSync(w.r.configFile, 0o600)
}
const editProfile = (w: World, patch: Record<string, unknown>, name = 'default') => {
  const c = cfg(w)
  Object.assign(c.profiles[name], patch)
  writeCfg(w, c)
}
const login = (w: World, extra: string[] = []) => w.r.run(['login', '--server', SERVER, ...extra])
/** The shared assertion: nothing issued by the authorization server is ever printed. */
const clean = (w: World, ...res: { stdout: string; stderr: string }[]) => {
  for (const x of res) for (const s of w.iss.secrets()) {
    expect(x.stdout).not.toContain(s)
    expect(x.stderr).not.toContain(s)
  }
}
const errCode = (stderr: string) => JSON.parse(stderr.split('\n').filter((l) => l.startsWith('{')).pop()!).error.code as string
const expireIn = (w: World, ms: number) => w.r.advance(profile(w).expires_at - w.r.now() - ms)
const meHits = (w: World) => w.net.at(SERVER, '/meta/v1/me')
const deviceRequests = (w: World) => w.net.at(w.iss.origin, '/oauth/device_authorization')
const form = (body: string) => Object.fromEntries(new URLSearchParams(body))
const tokenPosts = (w: World) => w.net.at(w.iss.origin, '/oauth/token').map((t) => form(t.body))

describe('device login: the happy path (D11)', () => {
  it('discovers, asks for the default scopes, polls, stores the profile, prints me alone on stdout and the prompt on stderr', async () => {
    const w = world({ issuer: { script: ['pending', 'ok'], device: { interval: 5, expires_in: 600 } } })
    const res = await login(w)
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual(ME)
    expect(res.stdout.trimEnd().split('\n')).toHaveLength(1)
    // prompt: the complete URL and the expiry, on stderr
    expect(res.stderr).toContain('https://issuer.test/activate?user_code=WDJB-MJHT')
    expect(res.stderr).toMatch(/10 minutes|600 seconds/)
    // device request: the CLI client id and D19's default scopes
    expect(deviceRequests(w)).toHaveLength(1)
    expect(form(deviceRequests(w)[0]!.body)).toEqual({ client_id: 'client_cli', scope: 'contacts:read contacts:write tasks:read offline_access' })
    // polling used the device grant with the CLI client id
    const polls = tokenPosts(w)
    expect(polls).toHaveLength(2)
    expect(polls[0]).toMatchObject({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'client_cli' })
    // the profile
    const p = profile(w)
    expect(p).toMatchObject({ kind: 'oauth', server: SERVER, issuer: 'https://issuer.test', client_id: 'client_cli', scope: 'contacts:read contacts:write tasks:read offline_access' })
    expect(p.access_token).toMatch(/^tok-access-/)
    expect(p.refresh_token).toMatch(/^tok-refresh-/)
    expect(p.expires_at).toBe(w.r.now() + 3600_000)
    expect(cfg(w).default_profile).toBe('default')
    expect(statSync(w.r.configFile).mode & 0o777).toBe(0o600)
    // the me call carried the new access token to the server
    expect(meHits(w)[0]!.headers.authorization).toBe(`Bearer ${p.access_token}`)
    clean(w, res)
  })

  it('without verification_uri_complete the prompt gives verification_uri and the user code', async () => {
    const w = world({ issuer: { device: { complete: false } } })
    const res = await login(w)
    expect(res.code).toBe(0)
    expect(res.stderr).toContain('https://issuer.test/activate')
    expect(res.stderr).toContain('WDJB-MJHT')
    expect(res.stderr).not.toContain('user_code=')
    clean(w, res)
  })

  it('writes the profile under --profile and later commands use it', async () => {
    const w = world()
    expect((await login(w, ['--profile', 'work'])).code).toBe(0)
    expect(profile(w, 'work').kind).toBe('oauth')
    const me = await w.r.run(['me', 'get', '--profile', 'work'])
    expect(me.code).toBe(0)
    expect(JSON.parse(me.stdout)).toEqual(ME)
  })

  it('a later command sends the stored access token to the server and nowhere else', async () => {
    const w = world()
    await login(w)
    const before = w.net.traffic.length
    const res = await w.r.run(['widgets', 'list'])
    expect(res.code).toBe(0)
    const sent = w.net.traffic.slice(before).filter((t) => t.headers.authorization)
    expect(sent.map((t) => t.origin)).toEqual([SERVER])
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${profile(w).access_token}`)
  })
})

describe('device login: polling (D11)', () => {
  it('honours the given interval, adds 5 s on slow_down, and keeps the larger interval', async () => {
    const w = world({ issuer: { script: ['pending', 'slow_down', 'pending', 'ok'], device: { interval: 3 } } })
    const res = await login(w)
    expect(res.code).toBe(0)
    expect(w.r.sleeps).toEqual([3000, 3000, 8000, 8000])
  })

  it('access_denied and expired_token are exit 1 and store nothing', async () => {
    for (const [outcome, code] of [['denied', 'access_denied'], ['expired', 'expired_token']] as const) {
      const w = world({ issuer: { script: ['pending', outcome] } })
      const res = await login(w)
      expect(res.code).toBe(1)
      expect(res.stdout).toBe('')
      expect(errCode(res.stderr)).toBe(code)
      expect(existsSync(w.r.configFile)).toBe(false)
      clean(w, res)
    }
  })

  it('stops when the device code has expired locally, without polling forever', async () => {
    const w = world({ issuer: { script: ['pending'], device: { expires_in: 20, interval: 5 } } })
    const res = await login(w)
    expect(res.code).toBe(1)
    expect(errCode(res.stderr)).toBe('expired_token')
    expect(w.iss.polls()).toBeLessThanOrEqual(5)
  })

  it('a non-JSON answer from the token endpoint is exit 1, not a crash', async () => {
    const w = world({ issuer: { script: ['html'] } })
    const res = await login(w)
    expect(res.code).toBe(1)
    expect(errCode(res.stderr)).toMatch(/invalid_response|http_403/)
  })
})

describe('a failed login leaves the profile as it was (decision c)', () => {
  it('a denied login over an API-key profile and over an OAuth profile keeps each byte for byte', async () => {
    const w = world()
    expect((await w.r.run(['login', '--api-key', '--server', SERVER, '--profile', 'k'], { stdin: KEY })).code).toBe(0)
    expect((await login(w, ['--profile', 'o'])).code).toBe(0)
    const before = readFileSync(w.r.configFile, 'utf8')
    w.iss.setScript(['denied'])
    for (const name of ['k', 'o']) {
      const res = await login(w, ['--profile', name])
      expect(res.code).toBe(1)
    }
    expect(readFileSync(w.r.configFile, 'utf8')).toBe(before)
    expect(profile(w, 'k')).toMatchObject({ kind: 'api_key', api_key: KEY })
  })

  it('a successful login replaces an API-key profile, and an OAuth one (new tokens)', async () => {
    const w = world()
    await w.r.run(['login', '--api-key', '--server', SERVER], { stdin: KEY })
    expect((await login(w)).code).toBe(0)
    const first = profile(w)
    expect(first.kind).toBe('oauth')
    expect(first.api_key).toBeUndefined()
    expect((await login(w)).code).toBe(0)
    expect(profile(w).refresh_token).not.toBe(first.refresh_token)
  })
})

describe('refusals before any device request (exit 2)', () => {
  const cases: [string, Parameters<typeof world>[0], string[], string][] = [
    ['auth is null (API keys only)', { auth: null }, [], 'api_keys_only'],
    ['cli_client_id is null', { auth: (i: string, o: string) => ({ provider: 'clerk', issuer: i, cli_client_id: null, protected_resource_metadata: o + '/.well-known/oauth-protected-resource' }) }, [], 'api_keys_only'],
    ['the issuer document names another issuer', { issuer: { metadata: (b) => ({ ...b, issuer: 'https://other.test' }) } }, [], 'issuer_mismatch'],
    ['a non-https issuer', { issuer: { origin: 'http://issuer.test' } }, [], 'insecure_issuer'],
    ['the token endpoint is off the issuer origin', { issuer: { metadata: (b) => ({ ...b, token_endpoint: 'https://evil.test/token' }) } }, [], 'endpoint_origin'],
    ['the device endpoint is off the issuer origin', { issuer: { metadata: (b) => ({ ...b, device_authorization_endpoint: 'https://evil.test/device' }) } }, [], 'endpoint_origin'],
    ['the revocation endpoint is off the issuer origin', { issuer: { metadata: (b) => ({ ...b, revocation_endpoint: 'https://evil.test/revoke' }) } }, [], 'endpoint_origin'],
    ['a token endpoint that is not https', { issuer: { metadata: (b) => ({ ...b, token_endpoint: 'http://issuer.test/oauth/token' }) } }, [], 'endpoint_origin'],
    ['a --scope entry the instance does not support', {}, ['--scope', 'contacts:read,bogus:scope'], 'unknown_scope'],
  ]
  it.each(cases)('%s', async (_name, opts, extra, code) => {
    const w = world(opts)
    const res = await login(w, extra)
    expect(res.code).toBe(2)
    expect(res.stdout).toBe('')
    expect(errCode(res.stderr)).toBe(code)
    expect(deviceRequests(w)).toEqual([])
    expect(w.net.at('https://evil.test')).toEqual([])
    expect(existsSync(w.r.configFile)).toBe(false)
    clean(w, res)
  })

  it('auth: null names --api-key', async () => {
    const w = world({ auth: null })
    expect(JSON.parse((await login(w)).stderr).error.message).toContain('--api-key')
  })
})

describe('--scope (D19)', () => {
  it('narrows the request, and offline_access is always added, once', async () => {
    const w = world()
    expect((await login(w, ['--scope', 'contacts:read'])).code).toBe(0)
    expect(form(deviceRequests(w)[0]!.body).scope).toBe('contacts:read offline_access')
    const w2 = world()
    expect((await login(w2, ['--scope', 'tasks:read,offline_access'])).code).toBe(0)
    expect(form(deviceRequests(w2)[0]!.body).scope).toBe('tasks:read offline_access')
  })
})

describe('credential routing (D18)', () => {
  const audit = (w: World) => {
    const access = w.iss.secrets().filter((s) => s.startsWith('tok-access-'))
    const refresh = w.iss.secrets().filter((s) => s.startsWith('tok-refresh-'))
    const device = w.iss.secrets().filter((s) => s.startsWith('tok-device-'))
    expect(access.length).toBeGreaterThan(1)
    expect(refresh.length).toBeGreaterThan(1)
    let authorized = 0
    for (const t of w.net.traffic) {
      const hay = JSON.stringify(t)
      const atToken = t.origin === w.iss.origin && (t.path === '/oauth/token' || t.path === '/oauth/revoke')
      if (t.origin !== SERVER) expect(t.headers.authorization, `${t.url} carried Authorization`).toBeUndefined()
      else if (t.headers.authorization) authorized++
      if (t.path.startsWith('/.well-known/')) expect(t.headers.authorization, `${t.url} carried Authorization`).toBeUndefined()
      for (const a of access) {
        if (t.origin === SERVER) expect(t.url + t.body).not.toContain(a)
        else expect(hay).not.toContain(a)
      }
      for (const x of refresh) if (!atToken) expect(hay, `${t.url} carried a refresh token`).not.toContain(x)
      for (const d of device) if (!(atToken && t.path === '/oauth/token')) expect(hay).not.toContain(d)
    }
    expect(authorized).toBeGreaterThan(1)
    expect(w.net.at(w.iss.origin, '/oauth/token').length).toBeGreaterThanOrEqual(2)
    expect(w.net.at(w.iss.origin, '/oauth/revoke').length).toBe(1)
  }

  it('across login, a refresh and logout: the access token only at the server, the refresh token only at the token and revocation endpoints, nothing at discovery', async () => {
    const w = world()
    const out = [await login(w)]
    expireIn(w, 30_000)
    out.push(await w.r.run(['me', 'get']))
    out.push(await w.r.run(['logout']))
    expect(out.map((o) => o.code)).toEqual([0, 0, 0])
    audit(w)
    clean(w, ...out)
  })

  it.each([
    ['the issuer metadata', '/.well-known/oauth-authorization-server', 'login'],
    ['the device endpoint', '/oauth/device_authorization', 'login'],
    ['the token endpoint during polling', '/oauth/token', 'login'],
  ])('a redirect from %s is not followed (a credential-free request, but the answer is never trusted off-origin)', async (_n, path, _cmd) => {
    const w = world({ issuer: { redirect: { path, to: 'https://evil.test/steal' } } })
    const res = await login(w)
    expect(res.code).not.toBe(0)
    expect(w.net.at('https://evil.test')).toEqual([])
    expect(existsSync(w.r.configFile)).toBe(false)
  })

  it('a redirect from the token endpoint on refresh, from the revocation endpoint on logout and from /meta/v1/me after login is not followed, so no token leaves', async () => {
    const w = world()
    expect((await login(w)).code).toBe(0)
    expireIn(w, 1000)
    w.iss.setRedirect({ path: '/oauth/token', to: 'https://evil.test/steal' })
    expect((await w.r.run(['me', 'get'])).code).toBe(1)
    w.iss.setRedirect({ path: '/oauth/revoke', to: 'https://evil.test/steal' })
    expect((await w.r.run(['logout'])).code).toBe(1)
    expect(w.net.at('https://evil.test')).toEqual([])

    const w2 = world()
    w2.meRedirect = 'https://evil.test/steal'
    const res = await login(w2)
    expect(res.code).toBe(1)
    expect(w2.net.at('https://evil.test')).toEqual([])
  })
})

describe('refresh (D20)', () => {
  it('a token within 60 s of expiry is refreshed before the request; one further out is not', async () => {
    const w = world()
    await login(w)
    const first = profile(w)
    expireIn(w, 61_000)
    expect((await w.r.run(['me', 'get'])).code).toBe(0)
    expect(w.iss.refreshCalls()).toBe(0)
    expireIn(w, 59_000)
    const res = await w.r.run(['me', 'get'])
    expect(res.code).toBe(0)
    expect(w.iss.refreshCalls()).toBe(1)
    const rp = tokenPosts(w).at(-1)!
    expect(rp).toEqual({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: 'client_cli' })
    const after = profile(w)
    expect(after.access_token).not.toBe(first.access_token)
    expect(after.refresh_token).not.toBe(first.refresh_token)
    expect(after.expires_at).toBe(w.r.now() + 3600_000)
    // the request that triggered it carried the new token
    expect(meHits(w).at(-1)!.headers.authorization).toBe(`Bearer ${after.access_token}`)
    clean(w, res)
  })

  it('a 401 triggers one refresh and one retry', async () => {
    const w = world()
    await login(w)
    const old = profile(w).access_token
    w.iss.rejectAccess(old)
    const before = meHits(w).length
    const res = await w.r.run(['me', 'get'])
    expect(res.code).toBe(0)
    expect(w.iss.refreshCalls()).toBe(1)
    expect(meHits(w).length - before).toBe(2)
    expect(meHits(w).at(-1)!.headers.authorization).toBe(`Bearer ${profile(w).access_token}`)
  })

  it('a second 401 is exit 1 without another refresh', async () => {
    const w = world()
    await login(w)
    w.denyAll = true
    const before = meHits(w).length
    const res = await w.r.run(['me', 'get'])
    expect(res.code).toBe(1)
    expect(errCode(res.stderr)).toBe('unauthorized')
    expect(w.iss.refreshCalls()).toBe(1)
    expect(meHits(w).length - before).toBe(2)
    clean(w, res)
  })

  it('the one retry is per command: a 401 on a later page of --all is exit 1 without a second refresh', async () => {
    const w = world()
    await login(w)
    w.iss.rejectAccess(profile(w).access_token)
    w.denyPage2 = true
    const res = await w.r.run(['widgets', 'list', '--all'])
    expect(res.code).toBe(1)
    expect(errCode(res.stderr)).toBe('unauthorized')
    expect(w.iss.refreshCalls()).toBe(1)
    expect(res.stdout.trimEnd().split('\n')).toHaveLength(1) // page 1 (after the refresh) was printed
  })

  it('an issuer that sends no refresh token: the access token works until near expiry, then login_required (exit 1)', async () => {
    const w = world({ issuer: { noRefresh: true } })
    expect((await login(w)).code).toBe(0)
    expect(profile(w).refresh_token).toBe('')
    const ok = await w.r.run(['me', 'get'])
    expect(ok.code).toBe(0)
    expect(meHits(w).at(-1)!.headers.authorization).toBe(`Bearer ${profile(w).access_token}`)
    expireIn(w, 30_000)
    const res = await w.r.run(['me', 'get'])
    expect(res.code).toBe(1)
    expect(errCode(res.stderr)).toBe('login_required')
    expect(res.stderr).toContain('vibase login')
    expect(w.iss.refreshCalls()).toBe(0)
  })

  it('a refresh that fails for another reason keeps the tokens, exit 1', async () => {
    const w = world()
    await login(w)
    const before = readFileSync(w.r.configFile, 'utf8')
    expireIn(w, 1000)
    const stored = readFileSync(w.r.configFile, 'utf8')
    w.iss.setRedirect({ path: '/oauth/token', to: 'https://evil.test/x' })
    const res = await w.r.run(['me', 'get'])
    expect(res.code).toBe(1)
    expect(readFileSync(w.r.configFile, 'utf8')).toBe(stored)
    expect(before).not.toBe('')
  })

  it('invalid_grant clears the tokens and exits 1 naming `vibase login`; the next command says the same, sending nothing', async () => {
    const w = world()
    await login(w)
    w.iss.forgetRefresh()
    expireIn(w, 1000)
    const res = await w.r.run(['me', 'get'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('vibase login')
    expect(profile(w)).toMatchObject({ kind: 'oauth', access_token: '', refresh_token: '', server: SERVER })
    expect(existsSync(w.r.configFile + '.lock')).toBe(false)
    const before = w.net.traffic.length
    const again = await w.r.run(['me', 'get'])
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('vibase login')
    expect(w.net.traffic.slice(before).filter((t) => t.headers.authorization)).toEqual([])
    clean(w, res, again)
  })
})

describe('the refresh lock (D20)', () => {
  const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)))

  it('two concurrent processes with an expired token make exactly one refresh call and both succeed', async () => {
    const w = world({ issuer: { refreshDelayMs: 60 } })
    await login(w)
    expireIn(w, -5000)
    const [a, b] = await Promise.all([w.r.run(['me', 'get'], { sleep: realSleep }), w.r.run(['me', 'get'], { sleep: realSleep })])
    expect([a.code, b.code]).toEqual([0, 0])
    expect(w.iss.refreshCalls()).toBe(1)
    expect(JSON.parse(a.stdout)).toEqual(ME)
    expect(JSON.parse(b.stdout)).toEqual(ME)
    expect(existsSync(w.r.configFile + '.lock')).toBe(false)
    clean(w, a, b)
  })

  it('a stale lock (older than 30 s) is taken over', async () => {
    const w = world()
    await login(w)
    expireIn(w, 1000)
    writeFileSync(w.r.configFile + '.lock', JSON.stringify({ id: 'dead', at: w.r.now() - 31_000 }))
    const res = await w.r.run(['me', 'get'])
    expect(res.code).toBe(0)
    expect(w.iss.refreshCalls()).toBe(1)
    expect(existsSync(w.r.configFile + '.lock')).toBe(false)
  })

  it('a lock held past 10 s is exit 1 and nothing is refreshed', async () => {
    const w = world()
    await login(w)
    expireIn(w, 1000)
    writeFileSync(w.r.configFile + '.lock', JSON.stringify({ id: 'live', at: w.r.now() }))
    const slept = w.r.sleeps.length
    const res = await w.r.run(['me', 'get'])
    expect(res.code).toBe(1)
    expect(errCode(res.stderr)).toBe('lock_timeout')
    expect(w.iss.refreshCalls()).toBe(0)
    const waited = w.r.sleeps.slice(slept).reduce((a, b) => a + b, 0)
    expect(waited).toBeGreaterThanOrEqual(10_000)
    expect(waited).toBeLessThan(15_000)
    expect(existsSync(w.r.configFile + '.lock')).toBe(true) // not ours: left alone
  })

  it('a process that finds the token already refreshed after waiting does not refresh again', async () => {
    const w = world({ issuer: { refreshDelayMs: 40 } })
    await login(w)
    w.iss.rejectAccess(profile(w).access_token)
    // two requests rejected with 401 at the same time: one refresh, the other adopts the result
    const [a, b] = await Promise.all([w.r.run(['me', 'get'], { sleep: realSleep }), w.r.run(['me', 'get'], { sleep: realSleep })])
    expect([a.code, b.code]).toEqual([0, 0])
    expect(w.iss.refreshCalls()).toBe(1)
  })
})

describe('logout (D21)', () => {
  it('revokes the refresh token (client_id, token_type_hint) and removes the profile', async () => {
    const w = world()
    await login(w)
    const rt = profile(w).refresh_token
    const res = await w.r.run(['logout'])
    expect(res.code).toBe(0)
    const rv = w.net.at(w.iss.origin, '/oauth/revoke')
    expect(rv).toHaveLength(1)
    expect(rv[0]!.headers['content-type']).toContain('application/x-www-form-urlencoded')
    expect(form(rv[0]!.body)).toEqual({ token: rt, token_type_hint: 'refresh_token', client_id: 'client_cli' })
    expect(w.iss.hasRefresh(rt)).toBe(false)
    expect(cfg(w).profiles.default).toBeUndefined()
    expect(cfg(w).default_profile).toBeUndefined()
    clean(w, res)
  })

  it('a failed revocation still removes the profile, reports on stderr, exit 1', async () => {
    const w = world({ issuer: { revocation: 'fail' } })
    await login(w)
    const res = await w.r.run(['logout'])
    expect(res.code).toBe(1)
    expect(res.stderr).not.toBe('')
    expect(res.stderr).toMatch(/revo/i)
    expect(cfg(w).profiles.default).toBeUndefined()
    clean(w, res)
  })

  it('an issuer without a revocation_endpoint: removed, a stderr note, exit 0', async () => {
    const w = world({ issuer: { revocation: 'none' } })
    await login(w)
    const res = await w.r.run(['logout'])
    expect(res.code).toBe(0)
    expect(res.stderr).toMatch(/revo/i)
    expect(w.net.at(w.iss.origin, '/oauth/revoke')).toEqual([])
    expect(cfg(w).profiles.default).toBeUndefined()
  })

  it('an unreachable issuer on logout is a failed revocation: removed, exit 1', async () => {
    const w = world()
    await login(w)
    editProfile(w, { issuer: 'https://gone.test' })
    const res = await w.r.run(['logout'])
    expect(res.code).toBe(1)
    expect(cfg(w).profiles.default).toBeUndefined()
  })

  it('a profile whose tokens were cleared logs out locally with no request', async () => {
    const w = world()
    await login(w)
    w.iss.forgetRefresh()
    expireIn(w, 1000)
    await w.r.run(['me', 'get'])
    const before = w.net.traffic.length
    const res = await w.r.run(['logout'])
    expect(res.code).toBe(0)
    expect(w.net.traffic.length).toBe(before)
    expect(cfg(w).profiles.default).toBeUndefined()
  })
})

describe('cycle 1 stays as it was', () => {
  it('VIBASE_API_KEY in the environment overrides an OAuth profile, and nothing is refreshed for it (D10)', async () => {
    const w = world()
    await login(w)
    expireIn(w, -1000)
    const stored = profile(w).access_token
    const before = w.net.traffic.length
    const res = await w.r.run(['me', 'get'], { env: { VIBASE_API_KEY: KEY } })
    expect(res.code).toBe(1) // the fake instance does not know that key: 401
    const sent = w.net.traffic.slice(before).filter((t) => t.headers.authorization)
    expect(sent.map((t) => t.headers.authorization)).toEqual([`Bearer ${KEY}`])
    expect(w.iss.refreshCalls()).toBe(0)
    expect(JSON.stringify(w.net.traffic.slice(before))).not.toContain(stored)
  })

  it('an OAuth profile is not used for another server', async () => {
    const w = world()
    await login(w)
    const before = w.net.traffic.length
    const res = await w.r.run(['me', 'get', '--server', 'https://elsewhere.test'])
    expect(res.code).not.toBe(0)
    expect(w.net.traffic.slice(before).filter((t) => t.headers.authorization)).toEqual([])
  })

  it('config get shows server and kind of an OAuth profile and refuses to show tokens', async () => {
    const w = world()
    await login(w)
    expect(JSON.parse((await w.r.run(['config', 'get', 'profiles.default.kind'])).stdout)).toBe('oauth')
    expect(JSON.parse((await w.r.run(['config', 'get', 'profiles.default.server'])).stdout)).toBe(SERVER)
    expect((await w.r.run(['config', 'get', 'profiles.default.refresh_token'])).code).toBe(2)
  })

  it('config set cannot repoint an OAuth profile at another server (its token would follow)', async () => {
    const w = world()
    await login(w)
    const res = await w.r.run(['config', 'set', 'profiles.default.server', 'https://elsewhere.test'])
    expect(res.code).toBe(2)
    expect(profile(w).server).toBe(SERVER)
  })

  it('the API-key profile and its logout still work next to an OAuth profile', async () => {
    const w = world()
    await login(w, ['--profile', 'o'])
    expect((await w.r.run(['login', '--api-key', '--server', SERVER, '--profile', 'k'], { stdin: KEY })).code).toBe(0)
    expect((await w.r.run(['logout', '--profile', 'k'])).code).toBe(0)
    expect(profile(w, 'o').kind).toBe('oauth')
  })
})
