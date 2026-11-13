// A small client for the vault's REST API with the Workflow's own agent key. It never logs or returns the key.

/** The scopes the Workflow's agent needs; the guide and the setup instructions list the same ones. */
export const REQUIRED_SCOPES = ['interactions:read', 'messages:read', 'connections:read', 'action_requests:read', 'messages:request_approval']

export interface VibaseDeps {
  /** The vault's origin, for example `https://api.example.com`. */
  baseUrl: string
  /** An agent API key (`vk_...`). */
  apiKey: string
  fetch: typeof fetch
  /** Builds the error that ends a Workflow step without retries (Cloudflare's `NonRetryableError`); a function so this file stays testable outside workerd. */
  nonRetryable: (message: string) => Error
}
export interface Vibase {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
}

/** A 4xx answer will not change on retry, except these: the request was early (408, 425), the record moved (409) or the vault is shedding load (429). */
const RETRYABLE_CLIENT_ERRORS = new Set([408, 409, 425, 429])

export function createVibase(deps: VibaseDeps): Vibase {
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const res = await deps.fetch(new URL(path, deps.baseUrl).href, {
      method,
      headers: { authorization: `Bearer ${deps.apiKey}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (res.ok) return (await res.json()) as T
    const detail = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    const message = `vibase ${res.status} ${detail?.error?.code ?? 'error'} on ${method} ${path.split('?')[0]}: ${detail?.error?.message ?? 'no detail'}`
    // Everything but a retryable client error below 500 ends the step: the same request would be refused the same way.
    throw res.status < 500 && !RETRYABLE_CLIENT_ERRORS.has(res.status) ? deps.nonRetryable(message) : new Error(message)
  }
  return { get: (path) => call('GET', path), post: (path, body) => call('POST', path, body) }
}
