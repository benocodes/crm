// The Worker's answers on `better-auth` as both setup kits fake them ([[OPS306]] obligation 1): `scripts/setup/better-auth-answers.test.ts` compares these builders with the real Worker
// (`composeD1Worker` on `better-auth` vars), so the fake cannot drift from the real shape.

export const discoveryAnswer = (base: string, signInMethods: string[] = ['password']) => ({
  auth: {
    provider: 'better-auth',
    issuer: `${base}/auth`,
    cli_client_id: 'vibase-cli',
    full_access_scope: 'all_permissions', // [[CORE660]] D2
    resource: base,
    protected_resource_metadata: `${base}/.well-known/oauth-protected-resource`,
    sign_in_methods: signInMethods,
    self_service_reset: false,
  },
})
/** The parts of the RFC 8414 metadata verify reads. */
export const metadataAnswer = (base: string) => ({ issuer: `${base}/auth` })

/** One scripted answer: an HTTP status and body, or a connection failure. */
export type Scripted = { status: number; body?: unknown } | 'throw'
/** The scripts for the two discovery URLs: each answer is used once, in order; the last one repeats. Absent: the correct answer. */
export interface BetterAuthScript {
  vibase?: Scripted[]
  metadata?: Scripted[]
  signInMethods?: string[]
}

/** Answers `url` (a `/.well-known/vibase` or the metadata path) from a script, or with the correct answer. Returns `undefined` for any other url. */
export function scriptedAnswer(
  url: string,
  s: BetterAuthScript,
  counters: { vibase: number; metadata: number },
): Response | undefined {
  const u = new URL(url)
  const base = u.origin
  const pick = (list: Scripted[] | undefined, key: 'vibase' | 'metadata', dflt: unknown): Response => {
    const n = counters[key]++
    const a = list?.[Math.min(n, list.length - 1)]
    if (a === 'throw') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(a ? (a.body ?? {}) : dflt), {
      status: a?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (u.pathname === '/.well-known/vibase') return pick(s.vibase, 'vibase', discoveryAnswer(base, s.signInMethods))
  if (u.pathname === '/.well-known/oauth-authorization-server/auth')
    return pick(s.metadata, 'metadata', metadataAnswer(base))
  return undefined
}
