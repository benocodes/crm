// The Cloudflare account subdomain endpoint as both setup kits fake it ([[OPS308]]): one answer builder, so the two fakes cannot drift apart.
// Shapes follow Cloudflare's API reference, https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/ (GET: `result.subdomain`)
// and .../methods/update/ (PUT body `{"subdomain": "<name>"}`, same result shape). The reference does not document the answer for an account with NO subdomain:
// the 404 with code 10007 below is what the API gives in practice and is UNCONFIRMED against the docs (RESULT.md); the code under test treats any 404 as "none".

export interface SubdomainState {
  /** The account's registered subdomain; `null`: none. */
  subdomain: string | null
  /** Every name a PUT registered, in order. */
  puts: string[]
  /** Both methods answer 403 (a token without Workers Scripts permission). */
  denied?: boolean
}

const envelope = (extra: Record<string, unknown>) => ({ errors: [], messages: [], ...extra })
export const subdomainSuccess = (subdomain: string) => envelope({ success: true, result: { subdomain } })
export const subdomainMissing = () => ({
  success: false,
  errors: [{ code: 10007, message: 'This account has not enabled a workers.dev subdomain.' }],
  messages: [],
  result: null,
})

/** Answers `GET|PUT accounts/<id>/workers/subdomain` from `st` (a PUT registers); `undefined` for any other path. `path` is relative to the API root. */
export function subdomainResponse(
  path: string,
  init: RequestInit | undefined,
  st: SubdomainState,
): Response | undefined {
  if (!/^accounts\/[^/]+\/workers\/subdomain$/.test(path)) return undefined
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (st.denied) return reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
  if ((init?.method ?? 'GET') === 'PUT') {
    const name = (JSON.parse(String(init?.body ?? '{}')) as { subdomain?: string }).subdomain ?? ''
    st.puts.push(name)
    st.subdomain = name
    return reply(200, subdomainSuccess(name))
  }
  return st.subdomain === null ? reply(404, subdomainMissing()) : reply(200, subdomainSuccess(st.subdomain))
}
