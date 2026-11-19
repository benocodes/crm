// [[UI30]] D8: the three calls the page makes. A fresh token from Clerk per request, sent only as `Authorization: Bearer`.
import type { AgentRecord, ConnectionRecord, Me } from './types.js'

export interface ApiResult<T> {
  status: number
  body: T | null
  /** Clerk had no token to give, so no request was made: the session is gone. */
  noToken?: true
  /** The `error.code` of a non-2xx answer, when it has one ([[UI467]] D3). */
  code?: string
  /** The `error.message` of a non-2xx answer, when it has one ([[UI468]] D7, D9: the server's words are shown). */
  message?: string
}
export interface Api {
  me(): Promise<ApiResult<Me>>
  /** Every agent: pages followed until `next_cursor` is null. */
  agents(): Promise<ApiResult<AgentRecord[]>>
  /** True when any agent has `disabled_at` null: pages are followed until one is found or the list ends (UI461 P4). */
  hasEnabledAgent(): Promise<ApiResult<boolean>>
  setDisabled(id: string, disabled: boolean): Promise<ApiResult<AgentRecord>>
  /** [[UI467]] D2: every connection, pages followed until `next_cursor` is null. */
  connections(): Promise<ApiResult<ConnectionRecord[]>>
  /** [[UI467]] D2, P5: a mailbox's address, the `value` of its own identity. */
  identityAddress(identityId: string): Promise<ApiResult<string>>
  /** [[UI467]] D3: `connections.authorize` for Google; the body is the consent URL to navigate to. */
  authorizeGmail(): Promise<ApiResult<{ authorize_url: string; expires_at: string }>>
  /** [[UI468]] D6: `connections.get`. */
  connection(id: string): Promise<ApiResult<ConnectionRecord>>
  /** [[UI468]] D7: `connections.update` (PATCH), the changed fields only; the body is the returned record. */
  updateConnection(id: string, body: object): Promise<ApiResult<ConnectionRecord>>
  /** [[UI468]] D9: `connections.sync`; `202` carries `requested_at`. */
  syncConnection(id: string): Promise<ApiResult<{ requested_at: string }>>
  /** [[UI468]] D8: `connections.delete`; `204` has no body. */
  deleteConnection(id: string): Promise<ApiResult<null>>
}

export function createApi(deps: { origin: string; getToken(): Promise<string | null>; fetch: typeof fetch }): Api {
  async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const token = await deps.getToken()
    if (!token) return { status: 401, body: null, noToken: true }
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await deps.fetch(`${deps.origin}${path}`, {
      method,
      headers,
      credentials: 'omit',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    let parsed: T | null = null
    try {
      parsed = (await res.json()) as T
    } catch {
      parsed = null
    }
    if (res.ok) return { status: res.status, body: parsed }
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error
    return {
      status: res.status,
      body: null,
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      ...(typeof error?.message === 'string' ? { message: error.message } : {}),
    }
  }

  return {
    me: () => call<Me>('GET', '/meta/v1/me'),
    async agents() {
      const all: AgentRecord[] = []
      let after: string | null = null
      // A page is a request with its own token. A server that never ends the cursor is bounded, not trusted.
      for (let i = 0; i < 100; i++) {
        const r: ApiResult<{ data: AgentRecord[]; next_cursor: string | null }> = await call(
          'GET',
          `/meta/v1/agents?limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        )
        if (r.status < 200 || r.status >= 300 || !r.body)
          return { status: r.status, body: null, ...(r.noToken ? { noToken: true as const } : {}) }
        all.push(...r.body.data)
        if (r.body.next_cursor === null) return { status: r.status, body: all }
        after = r.body.next_cursor
      }
      return { status: 200, body: all }
    },
    async hasEnabledAgent() {
      let after: string | null = null
      // Stops at the first enabled agent. A server that never ends the cursor is bounded, as `agents()` is.
      for (let i = 0; i < 100; i++) {
        const r: ApiResult<{ data: AgentRecord[]; next_cursor: string | null }> = await call(
          'GET',
          `/meta/v1/agents?limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        )
        if (r.status < 200 || r.status >= 300 || !r.body)
          return { status: r.status, body: null, ...(r.noToken ? { noToken: true as const } : {}) }
        if (r.body.data.some((a) => a.disabled_at === null)) return { status: r.status, body: true }
        if (r.body.next_cursor === null) return { status: r.status, body: false }
        after = r.body.next_cursor
      }
      return { status: 200, body: false }
    },
    setDisabled: (id, disabled) =>
      call<AgentRecord>('PATCH', `/meta/v1/agents/${encodeURIComponent(id)}`, { disabled }),
    async connections() {
      const all: ConnectionRecord[] = []
      let after: string | null = null
      // A page is a request with its own token; a server that never ends the cursor is bounded, as `agents()` is.
      for (let i = 0; i < 100; i++) {
        const r: ApiResult<{ data: ConnectionRecord[]; next_cursor: string | null }> = await call(
          'GET',
          `/meta/v1/connections?limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        )
        if (r.status < 200 || r.status >= 300 || !r.body) return { ...r, body: null }
        all.push(...r.body.data)
        if (r.body.next_cursor === null) return { status: r.status, body: all }
        after = r.body.next_cursor
      }
      return { status: 200, body: all }
    },
    async identityAddress(identityId) {
      const r = await call<{ value: string }>('GET', `/api/v1/identities/${encodeURIComponent(identityId)}`)
      return { ...r, body: r.body && typeof r.body.value === 'string' ? r.body.value : null }
    },
    authorizeGmail: () =>
      call<{ authorize_url: string; expires_at: string }>('POST', '/meta/v1/connections/authorize', {
        provider: 'google',
      }),
    connection: (id) => call<ConnectionRecord>('GET', `/meta/v1/connections/${encodeURIComponent(id)}`),
    updateConnection: (id, body) =>
      call<ConnectionRecord>('PATCH', `/meta/v1/connections/${encodeURIComponent(id)}`, body),
    syncConnection: (id) =>
      call<{ requested_at: string }>('POST', `/meta/v1/connections/${encodeURIComponent(id)}/sync`),
    deleteConnection: (id) => call<null>('DELETE', `/meta/v1/connections/${encodeURIComponent(id)}`),
  }
}
