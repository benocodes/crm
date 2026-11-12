// [[API7]] D13: the target URL rules. `https://` only, no credentials in the authority, no `localhost`, no IP literal in a loopback, private, link-local or CGNAT range, at most
// 2 048 characters. `allowInsecure` (`WEBHOOK_ALLOW_INSECURE_URLS=true`, local development and the local E2E only) also admits `http://` and loopback hosts; a private,
// link-local or CGNAT literal stays refused. Workers' `fetch` cannot reach a private network of the vault's, so this is hygiene, not the boundary.
export type UrlVerdict = { ok: true } | { ok: false; reason: string }

export const MAX_URL_LENGTH = 2048

const refuse = (reason: string): UrlVerdict => ({ ok: false, reason })

type Range = 'public' | 'loopback' | 'private'

/** The class of an IPv4 address given as four octets. */
function classifyV4([a, b]: readonly number[]): Range {
  if (a === 127) return 'loopback'
  if (a === 0 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b! >= 64 && b! <= 127)) return 'private'
  return 'public'
}

/** `::`-compressed IPv6 text (the URL parser's canonical form, brackets removed) to eight 16-bit groups; null when it is not one. */
function groupsOfV6(text: string): number[] | null {
  const halves = text.split('::')
  if (halves.length > 2) return null
  const side = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = side(halves[0]!)
  const tail = halves.length === 2 ? side(halves[1]!) : []
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - tail.length
  return fill < 1 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail]
}

function classifyV6(text: string): Range {
  const g = groupsOfV6(text)
  if (!g) return 'private' // not a literal we can read: refuse rather than guess
  const v4 = (hi: number, lo: number) => classifyV4([hi >> 8, hi & 255, lo >> 8, lo & 255])
  if (g.slice(0, 7).every((x) => x === 0)) return g[7] === 1 ? 'loopback' : g[7] === 0 ? 'private' : v4(g[6]!, g[7]!) // ::1, ::, and the deprecated IPv4-compatible form
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6]!, g[7]!) // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6]!, g[7]!) // NAT64 well-known prefix
  if ((g[0]! & 0xfe00) === 0xfc00) return 'private' // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return 'private' // link-local fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return 'private' // deprecated site-local fec0::/10
  return 'public'
}

export function validateWebhookUrl(raw: string, options: { allowInsecure: boolean }): UrlVerdict {
  if (raw.length > MAX_URL_LENGTH) return refuse(`the URL must be at most ${MAX_URL_LENGTH} characters`)
  if (raw.length === 0 || /\s/.test(raw)) return refuse('the URL must be a single URL without spaces')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return refuse('the URL is not a valid absolute URL')
  }
  if (url.protocol !== 'https:' && !(options.allowInsecure && url.protocol === 'http:')) return refuse('the URL must use https')
  if (url.username !== '' || url.password !== '') return refuse('the URL must not carry credentials')
  const host = url.hostname.toLowerCase()
  if (host === '') return refuse('the URL has no host')
  let range: Range
  if (host.startsWith('[') && host.endsWith(']')) range = classifyV6(host.slice(1, -1))
  else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) range = classifyV4(host.split('.').map(Number))
  else {
    const name = host.endsWith('.') ? host.slice(0, -1) : host
    range = name === 'localhost' || name.endsWith('.localhost') ? 'loopback' : 'public'
  }
  if (range === 'private') return refuse('the host must be a public name or address: no private, link-local or carrier-grade NAT address')
  if (range === 'loopback' && !options.allowInsecure) return refuse('the host must be a public name or address: no localhost or loopback address')
  return { ok: true }
}
