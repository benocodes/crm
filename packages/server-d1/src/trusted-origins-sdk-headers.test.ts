import { describe, expect, it } from 'vitest'
import { createAuthClient } from 'better-auth/client'
import { jwtClient } from 'better-auth/client/plugins'
import { AUTH_CORS_ALLOW_HEADERS } from './compose.js'

// [[UI255]] D7, group 3 (headers): the preflight's allowed request headers are pinned from the headers a REAL `better-auth/client` call emits (captured through a fake `fetch`), never from a hand-written list.
// A header is "simple" (needs no preflight allowance) when it is on the Fetch spec's safelist; every other header the SDK sends must be allowed.
const SAFELISTED = new Set(['accept', 'accept-language', 'content-language'])

async function captured(): Promise<string[]> {
  const seen = new Set<string>()
  const customFetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    for (const [k, v] of req.headers) {
      if (SAFELISTED.has(k)) continue
      // content-type is safelisted only for form, plain-text and multipart values; the SDK's JSON is not.
      if (k === 'content-type' && /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)/.test(v))
        continue
      seen.add(k)
    }
    return new Response(JSON.stringify(null), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = createAuthClient({
    baseURL: 'https://api.example.com',
    basePath: '/auth',
    plugins: [jwtClient()],
    fetchOptions: { customFetchImpl, credentials: 'include' },
  })
  await client.getSession()
  await client.signOut()
  await client.signIn.email({ email: 'a@b.test', password: 'a long enough password' })
  await client.token()
  return [...seen].sort()
}

describe('the allowed request headers', () => {
  it('are exactly the non-safelisted headers a real better-auth/client sends (get-session, sign-in, sign-out, token)', async () => {
    const sent = await captured()
    expect(sent.length).toBeGreaterThan(0)
    const allowed = AUTH_CORS_ALLOW_HEADERS.split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
      .sort()
    expect(allowed).toEqual(sent)
  })
})
