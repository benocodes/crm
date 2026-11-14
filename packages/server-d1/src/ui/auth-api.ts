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
    const code = (json as { code?: unknown } | null | undefined)?.code
    return typeof code === 'string' ? { ok: false, status: res.status, code } : { ok: false, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

const userOf = (json: unknown): SessionUser | undefined => {
  const u = (json as { user?: { email?: unknown; name?: unknown } } | null | undefined)?.user
  if (!u || typeof u.email !== 'string') return undefined
  return typeof u.name === 'string' ? { email: u.email, name: u.name } : { email: u.email }
}
const withUser = (r: ApiResult<unknown>): ApiResult<{ user?: SessionUser }> => {
  if (!r.ok) return r
  const user = userOf(r.data)
  return { ok: true, data: user ? { user } : {} }
}

export const signUp = async (b: { name: string; email: string; password: string; invitation_token: string }): Promise<ApiResult<{ user?: SessionUser }>> =>
  withUser(await call('POST', '/auth/sign-up/email', { name: b.name, email: b.email, password: b.password, invitation_token: b.invitation_token }))
export const signIn = async (b: { email: string; password: string }): Promise<ApiResult<{ user?: SessionUser }>> => withUser(await call('POST', '/auth/sign-in/email', { email: b.email, password: b.password }))
export const getSession = async (): Promise<ApiResult<{ user: SessionUser } | null>> => {
  const r = await call('GET', '/auth/get-session')
  if (!r.ok) return r
  const user = userOf(r.data)
  return { ok: true, data: user ? { user } : null }
}
export const signOut = (): Promise<ApiResult<unknown>> => call('POST', '/auth/sign-out', {})
export const resetPassword = (b: { newPassword: string; token: string }): Promise<ApiResult<unknown>> => call('POST', '/auth/reset-password', { newPassword: b.newPassword, token: b.token })
