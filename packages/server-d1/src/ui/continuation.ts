// [[UI247]] D6 (b), [[UI461]] D3: where `/sign-in` may send a person back to. The allow-list is exact pathnames: `/app/device` and the app's pages (`APP_PAGE_PATHS`, read at call time). A `return_to` is resolved against the page's origin and honoured only when
// it stays on that origin and its pathname is one of them (so `//evil.example/app/device`, `/app/device/../x`, `/app/devices` and `javascript:` are all ignored). Returns the path and query to go to, or null.
import { APP_PAGE_PATHS, DEVICE_PATH } from '../app/paths.js'

// [[UI510]] P6: the table's app pages plus `/app/device`, read at call time.
const allowed = (pathname: string): boolean => pathname === DEVICE_PATH || APP_PAGE_PATHS.some((p) => p === pathname)

export function returnTarget(search: string): string | null {
  const value = new URLSearchParams(search).get('return_to')
  if (value === null || value === '') return null
  let url: URL
  try {
    url = new URL(value, location.origin)
  } catch {
    return null
  }
  if (url.origin !== location.origin || !allowed(url.pathname)) return null
  // A bare `device` would resolve to `/device`: only a rooted path or an absolute URL of this origin is a target.
  if (!value.startsWith('/') && !value.startsWith(`${location.origin}/`)) return null
  return url.pathname + url.search
}

/**
 * [[UI255]] D8: a `return_to` that names ANOTHER origin: an absolute `https` URL, or `http://localhost[:port]`, with no credentials. It is never followed by the page: it is handed to Better Auth as `callbackURL`, whose
 * origin check (the server's `trustedOrigins`) refuses it with 403 unless the origin is trusted, and the page navigates only to the `url` a successful answer returns. Any other value (another scheme, plain `http` on
 * another host, the page's own origin, a relative path) is null here.
 */
export function crossOriginTarget(search: string): string | null {
  const value = new URLSearchParams(search).get('return_to')
  if (value === null || value === '') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')
  if (!ok || url.origin === location.origin || url.username !== '' || url.password !== '') return null
  return url.href
}
