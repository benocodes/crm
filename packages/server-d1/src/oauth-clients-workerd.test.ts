import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BASE, PAIRED_ORG, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { seedFirstPartyClient } from '@vibase/auth'
import { createVibaseRegistry } from '@vibase/api'
import { uuidv7 } from '@vibase/storage'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authKitOver } from './test/auth-kit.js'

// [[CORE627]] group 5: through the REAL composition in workerd (`better-auth`, the paired databases, a signed-in owner), an owner's POST /meta/v1/oauth-clients yields a client that completes Better Auth's
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
const authorize = async (id: string, resource: string, redirect = REDIRECT) => {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: id,
    redirect_uri: redirect,
    scope: 'openid offline_access contacts:read',
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
})
