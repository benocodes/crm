// The five same-origin calls the auth pages make to Better Auth ([[UI246]] D3), with `fetch` and no client SDK. Every answer is reduced to what a page may use: a success carries the (narrowed)
// data, a failure carries the HTTP status and the machine `code` of a JSON body. A server `message` is never carried, so no page can render one; a network failure is status 0.
export interface ApiFailure {
  ok: false
  status: number
  code?: string
}
export type ApiResult<T> = { ok: true; data: T } | ApiFailure
export interface SessionUser {
  email: string
  name?: string
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<unknown>> {
  try {
    const res = await fetch(path, {
      method,
      credentials: 'include',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let json: unknown
    try {
      json = text === '' ? undefined : JSON.parse(text)
    } catch {
      json = undefined
    }
    if (res.ok) return { ok: true, data: json }
    // Better Auth's own endpoints answer `{ code, message }`; the OAuth and device endpoints answer `{ error, error_description }` ([[UI247]] D6): `error` is a machine code too, the description is text a page never shows.
    const failure = json as { code?: unknown; error?: unknown } | null | undefined
    const code = typeof failure?.code === 'string' ? failure.code : typeof failure?.error === 'string' ? failure.error : undefined
    return code !== undefined ? { ok: false, status: res.status, code } : { ok: false, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

const userOf = (json: unknown): SessionUser | undefined => {
  const u = (json as { user?: { email?: unknown; name?: unknown } } | null | undefined)?.user
  if (!u || typeof u.email !== 'string') return undefined
  return typeof u.name === 'string' ? { email: u.email, name: u.name } : { email: u.email }
}
/** The only URLs a page follows after an OAuth answer: `http:` or `https:`, absolute or relative to the page's origin ([[UI247]] D4). */
export function isFollowable(url: string): boolean {
  if (url === '') return false
  try {
    const u = new URL(url, location.origin)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
const redirectOf = (json: unknown): string | null | undefined => {
  const b = json as { redirect?: unknown; url?: unknown } | null | undefined
  if (b?.redirect !== true) return undefined
  return typeof b.url === 'string' && isFollowable(b.url) ? b.url : null
}
/** Adds the answered redirect to a success's data, or turns an unusable one into a failure (`invalid_redirect`). The raw answer is read from `raw`. */
function withRedirect<D extends object>(r: { ok: true; data: D }, raw: unknown): ApiResult<D & { redirect?: string }> {
  const target = redirectOf(raw)
  if (target === null) return { ok: false, status: 200, code: 'invalid_redirect' }
  return target === undefined ? r : { ok: true, data: { ...r.data, redirect: target } }
}
const withUser = (r: ApiResult<unknown>): ApiResult<{ user?: SessionUser }> => {
  if (!r.ok) return r
  const user = userOf(r.data)
  return { ok: true, data: user ? { user } : {} }
}

export const signUp = async (b: { name: string; email: string; password: string; invitation_token: string }): Promise<ApiResult<{ user?: SessionUser }>> =>
  withUser(await call('POST', '/auth/sign-up/email', { name: b.name, email: b.email, password: b.password, invitation_token: b.invitation_token }))
/**
 * [[UI247]] D6: with `oauthQuery` (the signed query of an OAuth flow, verbatim) the request carries it as `oauth_query`, and a success may answer `{ redirect: true, url }`: the data then holds the
 * validated URL (`isFollowable`). A redirect that is not followable is a failure, never a navigation.
 */
export const signIn = async (b: { email: string; password: string; oauthQuery?: string }): Promise<ApiResult<{ user?: SessionUser; redirect?: string }>> => {
  const raw = await call('POST', '/auth/sign-in/email', { email: b.email, password: b.password, ...(b.oauthQuery === undefined ? {} : { oauth_query: b.oauthQuery }) })
  const r = withUser(raw)
  return r.ok && raw.ok ? withRedirect(r, raw.data) : r
}
export const getSession = async (): Promise<ApiResult<{ user: SessionUser } | null>> => {
  const r = await call('GET', '/auth/get-session')
  if (!r.ok) return r
  const user = userOf(r.data)
  return { ok: true, data: user ? { user } : null }
}
export const signOut = (): Promise<ApiResult<unknown>> => call('POST', '/auth/sign-out', {})
export const resetPassword = (b: { newPassword: string; token: string }): Promise<ApiResult<unknown>> => call('POST', '/auth/reset-password', { newPassword: b.newPassword, token: b.token })


const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** The answer of `GET /auth/device?user_code=`: claims a pending code for this session ([[UI247]] D3). `clientId` and `scope` come back only to the session that claimed it. */
export async function claimDeviceCode(userCode: string): Promise<ApiResult<{ status: string; clientId?: string; scope?: string }>> {
  const r = await call('GET', `/auth/device?user_code=${encodeURIComponent(userCode)}`)
  if (!r.ok) return r
  const b = (r.data ?? {}) as { status?: unknown; client_id?: unknown; scope?: unknown }
  const clientId = text(b.client_id)
  const scope = text(b.scope)
  return { ok: true, data: { status: text(b.status) ?? '', ...(clientId ? { clientId } : {}), ...(scope ? { scope } : {}) } }
}
export const approveDevice = (userCode: string): Promise<ApiResult<unknown>> => call('POST', '/auth/device/approve', { userCode })
export const denyDevice = (userCode: string): Promise<ApiResult<unknown>> => call('POST', '/auth/device/deny', { userCode })

/** An app's self-declared name (`GET /auth/oauth2/public-client`): text from an open registration, never trusted ([[UI247]] D4). */
export async function getClientName(clientId: string): Promise<ApiResult<{ name?: string }>> {
  const r = await call('GET', `/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`)
  if (!r.ok) return r
  const name = text((r.data as { client_name?: unknown } | null | undefined)?.client_name)
  return { ok: true, data: name ? { name } : {} }
}

/** `POST /auth/oauth2/consent`: all or nothing, the signed query verbatim, no `scope` ([[UI247]] D4). A success without a followable redirect is a failure. */
export async function submitConsent(accept: boolean, oauthQuery: string): Promise<ApiResult<{ redirect: string }>> {
  const r = await call('POST', '/auth/oauth2/consent', { accept, oauth_query: oauthQuery })
  if (!r.ok) return r
  const target = redirectOf(r.data)
  return typeof target === 'string' ? { ok: true, data: { redirect: target } } : { ok: false, status: 200, code: 'invalid_redirect' }
}
