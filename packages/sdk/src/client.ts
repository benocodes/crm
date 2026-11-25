import { VibaseError } from './errors.js'
import { serialiseFilter } from './filters.js'
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
  for (const [id, entry] of Object.entries(table)) {
    const namespace = (client[entry.namespace] ??= {})
    const send = (target: OperationEntry, args: Record<string, unknown>, callOptions?: CallOptions) =>
      call(origin, options.auth, doFetch, redirect, target, args, callOptions)
    const method = (args?: Record<string, unknown>, callOptions?: CallOptions) => send(entry, args ?? {}, callOptions)
    if (entry.paginated)
      Object.assign(method, {
        all: (args?: Record<string, unknown>, o?: CallOptions) => pages(send.bind(null, entry), args ?? {}, o),
      })
    if (entry.proposable)
      Object.assign(method, {
        propose: (args: Record<string, unknown>, proposal: Record<string, unknown>, o?: CallOptions) => {
          const create = table['action_requests.create']
          if (!create)
            throw new VibaseError(0, 'invalid_argument', 'This operation table has no action_requests.create')
          return send(create, { ...proposal, operation: id, arguments: args }, o)
        },
      })
    namespace[entry.method] = method
  }
  return client as Client<Ops>
}

/** `.all()`: one request per page, `after` from `next_cursor`, until it is null or empty; a repeated cursor is an invalid response (DX608 D10). */
async function* pages(
  send: (args: Record<string, unknown>, callOptions?: CallOptions) => Promise<unknown>,
  args: Record<string, unknown>,
  callOptions: CallOptions | undefined,
): AsyncGenerator<unknown> {
  const seen = new Set<string>()
  let after: string | undefined
  for (;;) {
    const page = (await send({ ...args, after }, callOptions)) as { data?: unknown; next_cursor?: unknown } | null
    if (!page || !Array.isArray(page.data)) throw new VibaseError(200, 'invalid_response', 'A page has no data list')
    yield* page.data
    const next = page.next_cursor
    if (next === null || next === undefined || next === '') return
    if (typeof next !== 'string' || seen.has(next))
      throw new VibaseError(200, 'invalid_response', 'The next_cursor repeats or is not a string')
    seen.add(next)
    after = next
  }
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
      const filter = entry.filters[name]
      if (filter) {
        if (value === null) continue
        for (const condition of serialiseFilter(name, value, filter)) query.push([name, condition])
        continue
      }
      if (entry.aggregateParams?.includes(name) && Array.isArray(value)) {
        // DX616 D5: an array is one comma-joined value; an empty one would change the answer's shape, so it is refused before anything is sent.
        if (value.length === 0)
          throw new VibaseError(400, 'validation_error', `${name}: give at least one field; nothing was sent`)
        query.push([name, value.join(',')])
        continue
      }
      for (const item of Array.isArray(value) ? value : [value])
        if (item !== undefined && item !== null) query.push([name, String(item)])
    } else if (entry.body) body[name] = value
  }
  return { path, query, body: entry.body ? body : undefined }
}

export async function failure(response: Response): Promise<VibaseError> {
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
