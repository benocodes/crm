import { failure } from './client.js'
import { VibaseError } from './errors.js'

export interface SessionTokenOptions {
  /** The deployment's URL; only its origin is used: the token is read from `<origin>/auth/token`. */
  url: string
  fetch?: typeof fetch
  /** A cookie header to send instead of the browser's cookies (server-side use); a function is called once per token request. */
  cookie?: string | (() => string | null | undefined | Promise<string | null | undefined>)
}

/**
 * The credential function for a Better Auth browser session (DX608 D7, P2): exchanges the session cookie at `GET /auth/token` on every call, never cached.
 * Resolves `null` when signed out (a 401, or a 2xx without a non-empty string `token`), so `createClient` answers `401 no_credential` without sending.
 */
export function sessionToken(options: SessionTokenOptions): () => Promise<string | null> {
  const endpoint = new URL('/auth/token', new URL(options.url).origin).toString()
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  return async () => {
    const cookie = typeof options.cookie === 'function' ? await options.cookie() : options.cookie
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.cookie !== undefined && cookie) headers.cookie = cookie
    let response: Response
    try {
      response = await doFetch(endpoint, {
        method: 'GET',
        headers,
        credentials: options.cookie === undefined ? 'include' : 'omit',
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new VibaseError(0, 'network_error', error instanceof Error ? error.message : String(error))
    }
    if (response.status === 401) return null
    if (!response.ok) throw await failure(response)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new VibaseError(
        response.status,
        'invalid_response',
        `The token response is not valid JSON (HTTP ${response.status})`,
      )
    }
    const token = (body as { token?: unknown } | null)?.token
    return typeof token === 'string' && token !== '' ? token : null
  }
}
