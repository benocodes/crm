// [[UI247]] D6 (b): where `/sign-in` may send a person back to. The allow-list is two pathnames, exactly: `/device` and `/connect`. A `return_to` is resolved against the page's origin and honoured only when
// it stays on that origin and its pathname is one of the two (so `//evil.example/device`, `/device/../x`, `/devices` and `javascript:` are all ignored). Returns the path and query to go to, or null.
const RETURN_PATHS: readonly string[] = ['/device', '/connect']

export function returnTarget(search: string): string | null {
  const value = new URLSearchParams(search).get('return_to')
  if (value === null || value === '') return null
  let url: URL
  try {
    url = new URL(value, location.origin)
  } catch {
    return null
  }
  if (url.origin !== location.origin || !RETURN_PATHS.includes(url.pathname)) return null
  // A bare `device` would resolve to `/device`: only a rooted path or an absolute URL of this origin is a target.
  if (!value.startsWith('/') && !value.startsWith(`${location.origin}/`)) return null
  return url.pathname + url.search
}
