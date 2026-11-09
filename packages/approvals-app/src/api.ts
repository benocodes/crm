// The vault REST calls the page makes. A fresh Clerk token per request, sent only as `Authorization: Bearer`.
import { config } from './runtime-config.js'
import type { ActionRequest } from './format.js'

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export interface Api {
  list(status: string): Promise<ActionRequest[]>
  /** One request; for messages.send this carries the body text, which the list does not. */
  get(id: string): Promise<ActionRequest>
  approve(id: string, reason?: string): Promise<ActionRequest>
  reject(id: string, reason?: string): Promise<ActionRequest>
}

export function createApi(getToken: () => Promise<string | null>, fetchImpl: typeof fetch = (i, init) => fetch(i, init)): Api {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken()
    if (!token) throw new ApiFailure(401, 'no_session', 'Your session has ended. Sign in again.')
    const res = await fetchImpl(config.apiOrigin + path, {
      method,
      credentials: 'omit',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const parsed = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    if (!res.ok) throw new ApiFailure(res.status, parsed?.error?.code ?? 'error', parsed?.error?.message ?? `Request failed (${res.status})`)
    return parsed as T
  }
  const decide = (verb: 'approve' | 'reject') => (id: string, reason?: string) =>
    call<ActionRequest>('POST', `/api/v1/action-requests/${encodeURIComponent(id)}/${verb}`, reason ? { decision_reason: reason } : {})
  return {
    async list(status) {
      const all: ActionRequest[] = []
      let after: string | null = null
      for (let i = 0; i < 20; i++) {
        const page: { data: ActionRequest[]; next_cursor: string | null } = await call('GET', `/api/v1/action-requests?status=${encodeURIComponent(status)}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`)
        all.push(...page.data)
        if (page.next_cursor === null) break
        after = page.next_cursor
      }
      return all
    },
    get: (id) => call<ActionRequest>('GET', `/api/v1/action-requests/${encodeURIComponent(id)}`),
    approve: decide('approve'),
    reject: decide('reject'),
  }
}
