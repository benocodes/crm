// [[UI30]] D8: the three calls the page makes. A fresh token from Clerk per request, sent only as `Authorization: Bearer`.
import type { AgentRecord, Me } from './types.js'

export interface ApiResult<T> {
  status: number
  body: T | null
  /** Clerk had no token to give, so no request was made: the session is gone. */
  noToken?: true
}
export interface Api {
  me(): Promise<ApiResult<Me>>
  /** Every agent: pages followed until `next_cursor` is null. */
  agents(): Promise<ApiResult<AgentRecord[]>>
  setDisabled(id: string, disabled: boolean): Promise<ApiResult<AgentRecord>>
}

export function createApi(deps: { origin: string; getToken(): Promise<string | null>; fetch: typeof fetch }): Api {
  async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const token = await deps.getToken()
    if (!token) return { status: 401, body: null, noToken: true }
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await deps.fetch(`${deps.origin}${path}`, { method, headers, credentials: 'omit', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    let parsed: T | null = null
    try {
      parsed = (await res.json()) as T
    } catch {
      parsed = null
    }
    return { status: res.status, body: res.ok ? parsed : null }
  }

  return {
    me: () => call<Me>('GET', '/meta/v1/me'),
    async agents() {
      const all: AgentRecord[] = []
      let after: string | null = null
      // A page is a request with its own token. A server that never ends the cursor is bounded, not trusted.
      for (let i = 0; i < 100; i++) {
        const r: ApiResult<{ data: AgentRecord[]; next_cursor: string | null }> = await call('GET', `/meta/v1/agents?limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`)
        if (r.status < 200 || r.status >= 300 || !r.body) return { status: r.status, body: null, ...(r.noToken ? { noToken: true as const } : {}) }
        all.push(...r.body.data)
        if (r.body.next_cursor === null) return { status: r.status, body: all }
        after = r.body.next_cursor
      }
      return { status: 200, body: all }
    },
    setDisabled: (id, disabled) => call<AgentRecord>('PATCH', `/meta/v1/agents/${encodeURIComponent(id)}`, { disabled }),
  }
}
