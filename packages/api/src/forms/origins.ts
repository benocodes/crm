/** [[CHN420]] D8, [[CHN424]] P1: the longest stored origin (the migration's CHECK holds the same bound). */
export const MAX_ORIGIN_LENGTH = 253

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * [[CHN424]] P1: the origin a browser would send in `Origin` for the input, or null when the input is not an allowed origin. Accepted: a URL the WHATWG parser reads, `https` (or `http` for
 * exactly `localhost`, `127.0.0.1` and `[::1]`), no userinfo, an empty path or `/`, no query or fragment (a bare `?` or `#` included), no `*` in the host. The result is `new URL(x).origin`: lowercase host,
 * punycode for a non-ASCII host, the default port dropped. Pure, so the ingress ([[CHN421]]) can compare a request's `Origin` against stored values with the same function.
 */
export function normaliseOrigin(raw: string): string | null {
  if (/[\s\\]/.test(raw) || raw.includes('?') || raw.includes('#')) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return null
  if (url.username !== '' || url.password !== '' || url.pathname !== '/') return null
  if (url.host.includes('*') || url.hostname === '') return null
  const origin = url.origin
  return origin === 'null' || origin.length > MAX_ORIGIN_LENGTH ? null : origin
}
