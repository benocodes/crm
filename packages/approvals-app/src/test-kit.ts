// Test helpers: a recording fake `fetch` for the vault's API origin, and a location stub. Not shipped (the build bundles from main.ts only).
import type { AppConfig } from './config.js'

export const API = 'http://localhost:8787'
export const APP_URL = 'http://localhost:8788/'
export const CONFIG: AppConfig = { apiOrigin: API, clerkIssuer: 'https://clerk.test', clerkPublishableKey: 'pk_test_x' }

export interface Seen {
  method: string
  url: string
  credentials: RequestCredentials | undefined
  headers: Record<string, string>
}
export type Handler = (req: Seen) => Response | Promise<Response>

/** `routes` maps `METHOD /path` (path under the API origin) to a response; an unlisted route is a 404, a handler that throws is a network error. */
export function fakeFetch(routes: Record<string, Handler | Response | object | null>) {
  const seen: Seen[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null
    const url = req ? req.url : String(input)
    const headers: Record<string, string> = {}
    new Headers(req ? req.headers : init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const s: Seen = {
      method: (req?.method ?? init?.method ?? 'GET').toUpperCase(),
      url,
      credentials: (req?.credentials ?? init?.credentials) as RequestCredentials | undefined,
      headers,
    }
    seen.push(s)
    const key = `${s.method} ${url.startsWith(API) ? url.slice(API.length) : url}`
    const route = routes[key.split('?')[0]!]
    if (route === undefined) return new Response('{"error":{"message":"not found"}}', { status: 404 })
    if (typeof route === 'function') return route(s)
    if (route instanceof Response) return route.clone()
    return Response.json(route)
  }) as typeof fetch
  return { fetch: impl, seen }
}

export function fakeLocation(href = APP_URL) {
  const calls = { assign: [] as string[], reload: 0 }
  return {
    calls,
    location: {
      href,
      assign: (u: string) => void calls.assign.push(u),
      reload: () => void calls.reload++,
    },
  }
}

export const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
