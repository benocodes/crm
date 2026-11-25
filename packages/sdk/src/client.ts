import { VibaseError } from './errors.js'
import { builtInOperations } from './generated/operations.js'
import type { BuiltInOperations } from './generated/types.js'
import type { Auth, CallOptions, Client, ClientOptions, OperationEntry, OperationMap } from './types.js'

/** How much of a non-JSON error body an `http_<status>` message keeps. */
const EXCERPT_LENGTH = 200

/**
 * The typed client of one deployment (DX603). One namespace per resource prefix, one method per operation:
 * `vibase.deals.moveStage({ id, stage_id })`. Methods take the flat arguments, resolve to the success body and
 * reject with a `VibaseError`.
 */
export function createClient<Ops extends OperationMap = BuiltInOperations>(options: ClientOptions<Ops>): Client<Ops> {
  const origin = new URL(options.url).origin
  const table = (options.operations ?? builtInOperations) as Record<string, OperationEntry>
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const redirect: RedirectMode = { value: 'error' }
  const client: Record<string, Record<string, unknown>> = {}
  for (const entry of Object.values(table)) {
    const namespace = (client[entry.namespace] ??= {})
    namespace[entry.method] = (args?: Record<string, unknown>, callOptions?: CallOptions) =>
      call(origin, options.auth, doFetch, redirect, entry, args ?? {}, callOptions)
  }
  return client as Client<Ops>
}

async function call(
  origin: string,
  auth: Auth,
  doFetch: typeof fetch,
  redirect: RedirectMode,
  entry: OperationEntry,
  args: Record<string, unknown>,
  callOptions: CallOptions | undefined,
): Promise<unknown> {
  // The origin guard comes first: a path that would leave the configured origin is refused before the credential is read.
  if (!/^\/(?![/\\])/.test(entry.path))
    throw new VibaseError(0, 'origin_mismatch', `Refusing ${entry.http} ${entry.path}: it would leave ${origin}`)
  const { path, query, body } = place(entry, args)
  const url = new URL(path, origin)
  if (url.origin !== origin)
    throw new VibaseError(0, 'origin_mismatch', `Refusing ${entry.http} ${entry.path}: it would leave ${origin}`)
  for (const [name, value] of query) url.searchParams.append(name, value)

  const token = typeof auth === 'function' ? await auth() : auth
  if (token === null || token === undefined)
    throw new VibaseError(401, 'no_credential', 'No credential: the auth function returned null')

  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'

  const send = () =>
    doFetch(url.toString(), {
      method: entry.http,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: callOptions?.signal,
      credentials: 'omit',
      redirect: redirect.value,
    })
  let response: Response
  try {
    try {
      response = await send()
    } catch (error) {
      // workerd rejects `redirect: 'error'` before sending anything: fall back to `manual` for this client and refuse a redirect below.
      if (redirect.value !== 'error' || !(error instanceof TypeError) || !/redirect/i.test(error.message)) throw error
      redirect.value = 'manual'
      response = await send()
    }
  } catch (error) {
    if (isAbort(error)) throw error
    throw new VibaseError(0, 'network_error', error instanceof Error ? error.message : String(error))
  }

  if (
    response.type === 'opaqueredirect' ||
    (redirect.value === 'manual' && response.status >= 300 && response.status < 400)
  )
    throw new VibaseError(
      response.status,
      'unexpected_redirect',
      `The server answered with a redirect (HTTP ${response.status}), which is never followed`,
    )
  if (!response.ok) throw await failure(response)
  if (entry.output === 'empty' || response.status === 204) return undefined
  if (entry.output === 'binary') return response
  try {
    return await response.json()
  } catch (error) {
    if (isAbort(error)) throw error
    throw new VibaseError(
      response.status,
      'invalid_response',
      `The response body is not valid JSON (HTTP ${response.status})`,
    )
  }
}

/** `error` where the runtime supports it (browsers, Node); `manual` on workerd, where a redirect response is refused instead. */
type RedirectMode = { value: 'error' | 'manual' }

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'

/** Splits the flat arguments by the table: the path with its fields substituted, the query pairs, the JSON body (or none). */
function place(entry: OperationEntry, args: Record<string, unknown>) {
  const path = entry.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = args[name]
    if (value === undefined || value === null)
      throw new VibaseError(0, 'invalid_argument', `Missing the path argument "${name}"`)
    return encodeURIComponent(String(value))
  })
  const query: [string, string][] = []
  const body: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue
    const place = entry.fields[name]
    if (place === 'path') continue
    if (place === 'query') {
      for (const item of Array.isArray(value) ? value : [value])
        if (item !== undefined && item !== null) query.push([name, String(item)])
    } else if (entry.body) body[name] = value
  }
  return { path, query, body: entry.body ? body : undefined }
}

async function failure(response: Response): Promise<VibaseError> {
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }
    const error = parsed?.error
    if (typeof error?.code === 'string' && typeof error.message === 'string')
      return new VibaseError(response.status, error.code, error.message)
  } catch {
    // not JSON: fall through to the generic code
  }
  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_LENGTH)
  return new VibaseError(
    response.status,
    `http_${response.status}`,
    excerpt ? `HTTP ${response.status}: ${excerpt}` : `HTTP ${response.status}`,
  )
}
