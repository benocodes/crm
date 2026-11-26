import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BASE, PAIRED_ORG, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { seedFirstPartyClient } from '@vibase/auth'
import { createVibaseRegistry } from '@vibase/api'
import { uuidv7 } from '@vibase/storage'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authKitOver } from './test/auth-kit.js'

// [[CORE627]] group 5 and [[CORE628]] group 3: through the REAL composition in workerd (`better-auth`, the paired databases, a signed-in owner), an owner's POST /meta/v1/oauth-clients yields a client that completes Better Auth's
// authorize with no consent screen, a PKCE token and a call to /api; the audit row names the owner; DELETE then makes refresh fail and authorize refuse the id.
const ENTRY = fileURLToPath(new URL('./test/entry-mint.ts', import.meta.url))
const declared = createVibaseRegistry().declaredScopes()
const REDIRECT = 'https://app.test/cb'
let n = 0
const ip = () => ({ 'cf-connecting-ip': `203.0.113.${(n++ % 250) + 1}` })
const verifier = 'v'.repeat(60)
const challenge = createHash('sha256').update(verifier).digest('base64url')

let bundle: Bundle
let w: Workerd
let cookie: string
let session: string
let owner: string
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({
    bundle,
    bindings: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, OPEN_ADMISSION: '1' },
    paired: true,
  })
  await seedFirstPartyClient(w.control as never, { baseURL: BASE })
  const kit = authKitOver(((p: string, i: object) => w.call(p, { ...i, headers: ip() })) as never, BASE, declared)
  const { userId, cookie: c } = await kit.signUp('owner@x.test')
  cookie = c
  owner = uuidv7()
  await seedPrincipal(w.d1, {
    id: owner,
    kind: 'user',
    email: 'owner@x.test',
    authProvider: 'better-auth',
    authSubject: userId,
  })
  await seedMembership(w.d1, { organizationId: PAIRED_ORG, userId: owner, role: 'owner' })
  session = await kit.sessionJwt(cookie)
}, 180_000)
afterAll(async () => {
  await w?.dispose()
  bundle?.dispose()
})

const meta = (method: string, path: string, body?: unknown) =>
  w.mf.dispatchFetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${session}`,
      ...ip(),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as Promise<Response>
const authorize = async (
  id: string,
  resource: string,
  redirect = REDIRECT,
  scope = 'openid offline_access contacts:read',
) => {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: id,
    redirect_uri: redirect,
    scope,
    state: 's1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
  })
  const res = (await w.mf.dispatchFetch(`${BASE}/auth/oauth2/authorize?${q}`, {
    redirect: 'manual',
    headers: { origin: BASE, ...ip(), cookie },
  })) as unknown as Response
  const text = await res.text()
  let raw = res.status === 302 ? res.headers.get('location') : null
  if (!raw) {
    try {
      raw = (JSON.parse(text) as { url?: string }).url ?? null
    } catch {
      /* an error body */
    }
  }
  return { status: res.status, text, url: raw ? new URL(raw, BASE) : null }
}
const token = async (form: Record<string, string>) => {
  const res = await w.call('/auth/oauth2/token', { form: true, body: form, headers: ip() })
  return { status: res.status, ...((await res.json()) as Record<string, any>) } as Record<string, any>
}

describe('group 5: composition, end to end in workerd', () => {
  it('create, a consent-free PKCE flow, a call to /api with the access token, the audit row, and delete as the revocation', async () => {
    const made = await meta('POST', '/meta/v1/oauth-clients', { name: 'Deals board', redirect_uris: [REDIRECT] })
    const rec = (await made.json()) as Record<string, any>
    expect(made.status, JSON.stringify(rec)).toBe(201)
    const id = rec.client_id as string
    expect(rec.skip_consent).toBe(true)
    expect(
      (
        await w.controlRows<{ t: string }>('select application_type t from auth_oauth_clients where client_id = ?', id)
      )[0]!.t,
    ).toBe('web')
    expect(rec.scopes).toContain('offline_access')

    const a = await authorize(id, BASE)
    expect(a.url, `authorize answered ${a.status} ${a.text}`).not.toBeNull()
    expect(a.url!.origin + a.url!.pathname).toBe(REDIRECT)
    const code = a.url!.searchParams.get('code')
    expect(code, a.text).toBeTruthy()
    const tokens = await token({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: id,
      resource: BASE,
    })
    expect(tokens.status, JSON.stringify(tokens)).toBe(200)
    expect(tokens.refresh_token).toBeTruthy()
    expect(
      (await w.call('/api/v1/contacts', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status,
    ).toBe(200)

    const audit = await w.controlRows<Record<string, any>>(
      "select actor_id, action from control_audit where target_id = ? and action = 'oauth_client.created'",
      id,
    )
    expect(audit).toEqual([{ actor_id: owner, action: 'oauth_client.created' }])

    const del = await meta('DELETE', `/meta/v1/oauth-clients/${id}`)
    expect(del.status).toBe(204)
    const refused = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: id,
      resource: BASE,
    })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(refused.access_token).toBeUndefined()
    const after = await authorize(id, BASE)
    expect(after.url?.searchParams.get('code') ?? null).toBeNull()
    expect(after.url?.searchParams.get('error')).toBe('invalid_client')
    expect((await meta('GET', `/meta/v1/oauth-clients/${id}`)).status).toBe(404)
  })

  it('an http loopback redirect completes authorize, token and refresh; http on another host is still refused at create', async () => {
    const LOOP = 'http://localhost:5199/cb'
    const made = await meta('POST', '/meta/v1/oauth-clients', { name: 'Local dev', redirect_uris: [LOOP] })
    const rec = (await made.json()) as Record<string, any>
    expect(made.status, JSON.stringify(rec)).toBe(201)
    const id = rec.client_id as string
    const typeOf = async (cid: string) =>
      (
        await w.controlRows<{ t: string }>('select application_type t from auth_oauth_clients where client_id = ?', cid)
      )[0]!.t
    expect(await typeOf(id)).toBe('native')
    const a = await authorize(id, BASE, LOOP)
    expect(a.url, `authorize answered ${a.status} ${a.text}`).not.toBeNull()
    expect(a.url!.origin + a.url!.pathname).toBe(LOOP)
    const code = a.url!.searchParams.get('code')
    expect(code, a.text).toBeTruthy()
    const tokens = await token({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      redirect_uri: LOOP,
      client_id: id,
      resource: BASE,
    })
    expect(tokens.status, JSON.stringify(tokens)).toBe(200)
    const again = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: id,
      resource: BASE,
    })
    expect(again.status, JSON.stringify(again)).toBe(200)
    expect(
      (await w.call('/api/v1/contacts', { headers: { authorization: `Bearer ${again.access_token}` } })).status,
    ).toBe(200)
    const refused = await meta('POST', '/meta/v1/oauth-clients', {
      name: 'Remote',
      redirect_uris: ['http://example.com/cb'],
    })
    expect(refused.status).toBe(400)
  })
  // [[CORE628]] group 3: application_type follows the redirect list on update, and an edit revokes nothing.
  const typeOf = async (cid: string) =>
    (
      await w.controlRows<{ t: string }>('select application_type t from auth_oauth_clients where client_id = ?', cid)
    )[0]!.t
  const LOOPBACK = 'http://localhost:5199/cb'
  const flow = async (id: string, redirect: string) => {
    const a = await authorize(id, BASE, redirect)
    const code = a.url?.searchParams.get('code') ?? null
    if (!code) return { a, tokens: null }
    const tokens = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: id,
      resource: BASE,
    })
    return { a, tokens }
  }
  const refresh = (id: string, refreshToken: string) =>
    token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: id, resource: BASE })
  const make = async (redirects: string[]) => {
    const res = await meta('POST', '/meta/v1/oauth-clients', { name: 'Edited', redirect_uris: redirects })
    const rec = (await res.json()) as Record<string, any>
    expect(res.status, JSON.stringify(rec)).toBe(201)
    return rec.client_id as string
  }

  it('a client created https-only and updated to a loopback http URI is stored native and completes authorize (no consent), token and refresh on it; updated back to https it is web and the loopback URI is refused', async () => {
    const id = await make([REDIRECT])
    expect(await typeOf(id)).toBe('web')
    const upd = await meta('PATCH', `/meta/v1/oauth-clients/${id}`, { redirect_uris: [LOOPBACK] })
    expect(upd.status, await upd.text()).toBe(200)
    expect(await typeOf(id)).toBe('native')
    const { a, tokens } = await flow(id, LOOPBACK)
    expect(a.url, `authorize answered ${a.status} ${a.text}`).not.toBeNull()
    expect(a.url!.origin + a.url!.pathname).toBe(LOOPBACK)
    expect(tokens?.status, JSON.stringify(tokens)).toBe(200)
    const again = await refresh(id, tokens!.refresh_token)
    expect(again.status, JSON.stringify(again)).toBe(200)
    expect(
      (await w.call('/api/v1/contacts', { headers: { authorization: `Bearer ${again.access_token}` } })).status,
    ).toBe(200)
    const back = await meta('PATCH', `/meta/v1/oauth-clients/${id}`, { redirect_uris: [REDIRECT] })
    expect(back.status).toBe(200)
    expect(await typeOf(id)).toBe('web')
    expect((await flow(id, REDIRECT)).tokens?.status).toBe(200)
  })

  it('a loopback-only client updated to https-only is stored web, and authorize with the old loopback URI is refused', async () => {
    const id = await make([LOOPBACK])
    expect(await typeOf(id)).toBe('native')
    expect((await meta('PATCH', `/meta/v1/oauth-clients/${id}`, { redirect_uris: [REDIRECT] })).status).toBe(200)
    expect(await typeOf(id)).toBe('web')
    const old = await authorize(id, BASE, LOOPBACK)
    expect(old.url?.searchParams.get('code') ?? null).toBeNull()
    expect((await flow(id, REDIRECT)).tokens?.status).toBe(200)
  })

  it('an update that leaves redirect_uris alone leaves application_type alone', async () => {
    const id = await make([LOOPBACK])
    expect((await meta('PATCH', `/meta/v1/oauth-clients/${id}`, { name: 'Renamed' })).status).toBe(200)
    expect(await typeOf(id)).toBe('native')
  })

  it('a refresh token issued before a name-only edit, and before a redirect edit, still refreshes after it (D8); the audit rows name the owner', async () => {
    const id = await make([REDIRECT])
    const first = (await flow(id, REDIRECT)).tokens!
    expect(first.status, JSON.stringify(first)).toBe(200)
    expect((await meta('PATCH', `/meta/v1/oauth-clients/${id}`, { name: 'Renamed' })).status).toBe(200)
    const second = await refresh(id, first.refresh_token)
    expect(second.status, JSON.stringify(second)).toBe(200)
    expect(
      (await meta('PATCH', `/meta/v1/oauth-clients/${id}`, { redirect_uris: [REDIRECT, 'https://two.test/cb'] }))
        .status,
    ).toBe(200)
    const third = await refresh(id, second.refresh_token)
    expect(third.status, JSON.stringify(third)).toBe(200)
    const audit = await w.controlRows<Record<string, any>>(
      "select actor_id from control_audit where target_id = ? and action = 'oauth_client.updated'",
      id,
    )
    expect(audit).toEqual([{ actor_id: owner }, { actor_id: owner }])
  })
})

// ---- [[CORE639]] groups 4 and 5: NULL scopes through Better Auth's real authorize, token and refresh, and a first-party token as the person through the composed Worker.
describe('CORE639: first-party apps act as the signed-in person, end to end in workerd', () => {
  const SCOPE_OUTSIDE_DEFAULTS = 'openid offline_access contacts:read members:write'
  const decodeJwt = (t: string) =>
    JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>
  const make = async (extra: Record<string, unknown> = {}) => {
    const res = await meta('POST', '/meta/v1/oauth-clients', {
      name: 'Deals board',
      redirect_uris: [REDIRECT],
      ...extra,
    })
    const rec = (await res.json()) as Record<string, any>
    expect(res.status, JSON.stringify(rec)).toBe(201)
    return rec
  }
  const tokensOf = async (id: string, scope?: string) => {
    const a = await authorize(id, BASE, REDIRECT, scope)
    const code = a.url?.searchParams.get('code') ?? null
    expect(code, `authorize answered ${a.status} ${a.text}`).toBeTruthy()
    return token({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: id,
      resource: BASE,
    })
  }
  const asApp = (t: string, path: string) => w.call(path, { headers: { authorization: `Bearer ${t}` } })

  it('a NULL-scope client authorizes a scope outside the old defaults with no consent, and refresh works; a listed client is refused the same scope', async () => {
    const followed = await make()
    expect(followed.scopes).toBeNull()
    const first = await tokensOf(followed.client_id, SCOPE_OUTSIDE_DEFAULTS)
    expect(first.status, JSON.stringify(first)).toBe(200)
    expect(decodeJwt(first.access_token).scope).toContain('members:write')
    const again = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: followed.client_id,
      resource: BASE,
    })
    expect(again.status, JSON.stringify(again)).toBe(200)
    const listed = await make({ scopes: ['openid', 'offline_access', 'contacts:read'] })
    const refused = await authorize(listed.client_id, BASE, REDIRECT, SCOPE_OUTSIDE_DEFAULTS)
    expect(refused.url?.searchParams.get('code') ?? null).toBeNull()
  })

  it('me.get with a first-party token through the composed Worker is the owner as a user: the app named, every ceiling scope held though never asked, no human-only scope, no agent row', async () => {
    const rec = await make()
    const tokens = await tokensOf(rec.client_id, SCOPE_OUTSIDE_DEFAULTS)
    const res = await asApp(tokens.access_token, '/meta/v1/me')
    const me = (await res.json()) as Record<string, any>
    expect(res.status, JSON.stringify(me)).toBe(200)
    expect(me.principal).toMatchObject({ kind: 'user', id: owner })
    expect(me.client_id).toBe(rec.client_id)
    expect(me.active_organization.role).toBe('owner')
    expect(me.active_organization.scopes).toContain('deals:write')
    for (const human of ['members:write', 'oauth_clients:write'])
      expect(me.active_organization.scopes).not.toContain(human)
    const agents = (await w.d1.prepare('select count(*) n from agents').first()) as { n: number }
    expect(agents.n).toBe(0)
  })
})
