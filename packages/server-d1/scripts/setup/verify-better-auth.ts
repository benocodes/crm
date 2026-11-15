// The Better Auth half of verify and of the closing output, shared by both setup front-ends ([[OPS306]], [[OPS249]] D4, D5, D8). Pure but for the injected `fetch`, clock and `sleep`:
// no subprocess, no file. The expected issuer comes from the recorded PUBLIC_BASE_URL (`https://<api host>`), never from a request host ([[CORE243]] D23).

/** [[OPS249]] D5, P3 and [[OPS307]]: the statement both front-ends print on `better-auth` without email, and that the docs quote. [[CORE243]] D16's full text, owner sentence included. */
export const NO_EMAIL_STATEMENT =
  "Email is not configured: there is no self-service password reset. A member who forgets their password gets a reset link from an owner; an owner gets one from `vibase-server owner-reset` (needs this instance's Cloudflare credentials). Invitation links are printed for you to send."

export const DISCOVERY_BOUND_MS = 300_000
export const DISCOVERY_INTERVAL_MS = 10_000

export interface DiscoveryReads {
  fetch: typeof fetch
  now(): number
  sleep(ms: number): Promise<void>
  /** A dry run reads once: a transient answer fails at once, nothing is retried. */
  dryRun: boolean
  /** The instant verify started, so the health wait and these reads share one bound ([[OPS308]] P2); default: now. */
  start?: number
}
export type IssuerCheck = { ok: true; signInMethods: string[] } | { ok: false; detail: string }

type Answer = { kind: 'transient'; detail: string } | { kind: 'final'; status: number; json: unknown }

/** One read: a 5xx or no answer is transient (a fresh Worker answers 500 until its secrets reach the edge, [[CORE243]] D6); anything else is final. */
async function read(f: typeof fetch, url: string): Promise<Answer> {
  try {
    const res = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (res.status >= 500) return { kind: 'transient', detail: `answered ${res.status}` }
    let json: unknown = null
    if (res.status === 200) {
      try {
        json = await res.json()
      } catch {
        json = null
      }
    }
    return { kind: 'final', status: res.status, json }
  } catch {
    return { kind: 'transient', detail: 'did not answer' }
  }
}

/** [[OPS306]] D8, P1: the Worker serves the configured issuer, in discovery and in the RFC 8414 metadata. The retries share one bound, on the injected clock. */
export async function checkBetterAuthIssuer(base: string, r: DiscoveryReads): Promise<IssuerCheck> {
  const issuer = `${base}/auth`
  const start = r.start ?? r.now()
  const fetchFinal = async (path: string): Promise<{ status: number; json: unknown } | string> => {
    const url = `${base}${path}`
    for (;;) {
      const a = await read(r.fetch, url)
      if (a.kind === 'final') return a
      if (r.dryRun) return `${url} ${a.detail}`
      if (r.now() - start >= DISCOVERY_BOUND_MS)
        return `${url} still ${a.detail} after ${Math.round((r.now() - start) / 1000)}s in total`
      await r.sleep(DISCOVERY_INTERVAL_MS)
    }
  }
  const disc = await fetchFinal('/.well-known/vibase')
  if (typeof disc === 'string') return { ok: false, detail: disc }
  if (disc.status !== 200) return { ok: false, detail: `${base}/.well-known/vibase answered ${disc.status}` }
  const auth = (
    disc.json as { auth?: { provider?: unknown; issuer?: unknown; sign_in_methods?: unknown } | null } | null
  )?.auth
  if (!auth)
    return {
      ok: false,
      detail: `${base}/.well-known/vibase reports no auth provider: the Worker is not on better-auth (is AUTH_PROVIDER deployed, and the secrets in place?)`,
    }
  const bad: string[] = []
  if (auth.provider !== 'better-auth')
    bad.push(`auth.provider is ${String(auth.provider)}, setup configured better-auth`)
  if (auth.issuer !== issuer) bad.push(`auth.issuer is ${String(auth.issuer)}, setup configured ${issuer}`)
  if (bad.length) return { ok: false, detail: `${base}/.well-known/vibase disagrees: ${bad.join('; ')}` }
  const meta = await fetchFinal('/.well-known/oauth-authorization-server/auth')
  if (typeof meta === 'string') return { ok: false, detail: meta }
  if (meta.status !== 200)
    return { ok: false, detail: `${base}/.well-known/oauth-authorization-server/auth answered ${meta.status}` }
  const metaIssuer = (meta.json as { issuer?: unknown } | null)?.issuer
  if (metaIssuer !== issuer)
    return {
      ok: false,
      detail: `${base}/.well-known/oauth-authorization-server/auth disagrees: issuer is ${String(metaIssuer)}, setup configured ${issuer}`,
    }
  const methods = Array.isArray(auth.sign_in_methods)
    ? auth.sign_in_methods.filter((m): m is string => typeof m === 'string')
    : []
  return { ok: true, signInMethods: methods }
}

/**
 * [[OPS249]] D5: email is configured when the record holds the `send_email` binding named `EMAIL` and a non-empty `AUTH_EMAIL_FROM`; one without the other is not. `block` is the env block of
 * wrangler.jsonc (`setup:remote`); `vibase-server`'s settings file cannot hold a binding, so it never calls this and always prints the statement.
 */
export function emailConfigured(block: { send_email?: unknown; vars?: Record<string, unknown> } | undefined): boolean {
  const binding =
    Array.isArray(block?.send_email) &&
    block.send_email.some((b) => typeof b === 'object' && b !== null && (b as { name?: unknown }).name === 'EMAIL')
  const from = block?.vars?.AUTH_EMAIL_FROM
  return binding && typeof from === 'string' && from.trim() !== ''
}

export interface NextStepsInput {
  /** `https://<api host>`. */
  url: string
  /** The bootstrap step issued an owner invitation in this run: only then does the claim line appear. */
  claimLink: boolean
  /** Discovery's `sign_in_methods` contains `google`. */
  google: boolean
  emailConfigured: boolean
  /** Today's operator-key hint lines, unchanged. */
  hint: string[]
}

/** [[OPS306]] D8: the owner's next steps on `better-auth`, in order. The invitation link itself never appears here (the bootstrap step prints it once). */
export function betterAuthNextSteps(i: NextStepsInput): string[] {
  return [
    `API: ${i.url}`,
    ...(i.claimLink ? ['open the owner invitation link printed above by the bootstrap step; it is shown once'] : []),
    `vibase login --server ${i.url}`,
    `MCP: ${i.url}/mcp`,
    ...(i.google ? [`manual add the redirect URI ${i.url}/auth/callback/google to the Google OAuth client`] : []),
    ...(i.emailConfigured ? [] : [NO_EMAIL_STATEMENT]),
    ...i.hint,
  ]
}
