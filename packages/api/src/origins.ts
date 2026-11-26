// [[API622]] D1-D3: the origin entry grammar and the one matcher. No imports on purpose: `server-d1`'s early.ts reaches this through the `@vibase/api/origins` subpath without loading the index.

/** A domain name made of letters, digits and hyphens in dot-separated labels, with an optional port. The `*.` of a wildcard entry is stripped before this runs. */
const HOST_AND_PORT = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(:[0-9]{1,5})?$/
const WILDCARD_ENTRY = /^(https?):\/\/\*\.(.+)$/

/** An origin as a browser sends it with a wildcard's `*` already matched: one or more dot-separated host labels. */
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

/**
 * D2: `scheme://*.<host>[:port]` where `*.` is the whole first label and the base `scheme://<host>[:port]` is a domain name (no IP literal). Returns the base origin, or `undefined` for anything else (an entry
 * with no `*` included): `*`, `https://*`, no scheme, `foo*`, an inner `*`, `**`, `?`, a path, query or fragment, an IP-literal base, `chrome-extension://*`. Each var applies its own scheme rule to the base.
 */
export function parseWildcardOrigin(entry: string): string | undefined {
  const m = WILDCARD_ENTRY.exec(entry)
  if (m === null) return undefined
  const [, scheme, rest] = m
  const hp = HOST_AND_PORT.exec(rest)
  if (hp === null) return undefined
  const host = hp[1]
  // An IPv4 literal (all-numeric labels) is not a domain name; IPv6 never reaches here (the character class refuses `[`).
  if (/^[0-9.]+$/.test(host)) return undefined
  if (hp[2] !== undefined && Number(hp[2].slice(1)) > 65535) return undefined
  try {
    const base = `${scheme}://${rest}`
    return new URL(base).origin === base ? base : undefined
  } catch {
    return undefined
  }
}

/**
 * D1/D3: does `origin` match one of `entries` (exact origins, or the wildcard form of D2)? A wildcard matches a subdomain of its host at any depth, never the bare host, another scheme or another port
 * (the same meaning as Better Auth's `trustedOrigins` matcher, proven by a parity test in `@vibase/auth`). Origins are compared as sent, case-sensitively, as `includes` did.
 */
export function originMatches(entries: readonly string[], origin: string): boolean {
  for (const entry of entries) {
    if (!entry.includes('*')) {
      if (entry === origin) return true
      continue
    }
    const base = parseWildcardOrigin(entry)
    if (base === undefined) continue
    const schemeEnd = base.indexOf('://') + 3
    const prefix = base.slice(0, schemeEnd)
    const suffix = `.${base.slice(schemeEnd)}`
    if (origin.length <= prefix.length + suffix.length) continue
    if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) continue
    if (SUBDOMAIN.test(origin.slice(prefix.length, origin.length - suffix.length))) return true
  }
  return false
}
