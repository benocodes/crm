// Test helpers: a fake Better Auth deployment (discovery, token endpoint, the two API calls the page makes) recording every request,
// and stores and a location the page is driven through. Not shipped (the build bundles from main.ts only).
import type { AppConfig } from './settings.js'

export const API = 'http://localhost:8787'
export const APP = 'http://localhost:5180'
export const CONFIG: AppConfig = { vibaseUrl: API, clientId: 'client-1' }
export const ISSUER = `${API}/auth`

export interface Seen {
  method: string
  url: string
  credentials: RequestCredentials | undefined
  authorization: string | undefined
  form: URLSearchParams | undefined
}
type Answer = { status?: number; body: unknown }
export interface Deployment {
  /** Answers for `GET /meta/v1/me` and `GET /api/v1/contacts`; mutate between steps. */
  me: () => Answer
  contacts: () => Answer
  /** Answers for the token endpoint by grant type. */
  token: (form: URLSearchParams) => Answer
}

const json = (a: Answer) =>
  new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } })

let counter = 0
export function deployment(over: Partial<Deployment> = {}) {
  const seen: Seen[] = []
  const d: Deployment = {
    me: () => ({
      body: { principal: { id: 'p1', kind: 'user' }, user: { id: 'u1', email: 'owner@e2e.test', name: 'Owner' } },
    }),
    contacts: () => ({ body: { data: [{ id: 'c1', name: 'Ada Lovelace' }, { id: 'c2', name: 'Grace Hopper' }], next_cursor: null } }),
    token: (form) =>
      form.get('grant_type') === 'refresh_token'
        ? { body: { access_token: `at-refreshed-${++counter}`, refresh_token: 'rt-2', expires_in: 3600 } }
        : { body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } },
    ...over,
  }
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const headers = new Headers(init.headers)
    seen.push({
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      credentials: init.credentials,
      authorization: headers.get('authorization') ?? undefined,
      form: typeof init.body === 'string' ? new URLSearchParams(init.body) : undefined,
    })
    const path = url.slice(API.length).split('?')[0]
    if (path === '/.well-known/vibase') return json({ body: { auth: { provider: 'better-auth', issuer: ISSUER, resource: API } } })
    if (path === '/.well-known/oauth-authorization-server/auth')
      return json({
        body: {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth2/authorize`,
          token_endpoint: `${ISSUER}/oauth2/token`,
          code_challenge_methods_supported: ['S256'],
        },
      })
    if (path === '/auth/oauth2/token') return json(d.token(new URLSearchParams(String(init.body))))
    if (path === '/meta/v1/me') return json(d.me())
    if (path === '/api/v1/contacts') return json(d.contacts())
    return json({ status: 404, body: { error: { code: 'not_found', message: 'no route' } } })
  }) as typeof fetch
  return { d, fetch: impl, seen, tokenRequests: () => seen.filter((s) => s.url === `${ISSUER}/oauth2/token`) }
}

export class Mem {
  readonly map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
}

export const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
