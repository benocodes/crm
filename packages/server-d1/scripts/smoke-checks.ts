// The key-less, write-free checks of a deployed instance ([[OPS4]] C9's after-phase, [[OPS234]] P1), shared by `smoke:remote` (which prints them) and
// `vibase-server upgrade` (which runs `keylessChecks` after its verify). Everything here is a plain GET; nothing sends an operator key.
type Json = Record<string, unknown>

/** The `after` health check: initialised, the expected version, and every core migration applied ([[CORE61]] D7). `accept` widens the status for a rollback (`ahead`). */
export function afterHealthOk(status: number, json: Json | null, version: string, accept: readonly string[] = ['current']): boolean {
  const m = (json?.migrations as Json | undefined)?.status
  return status === 200 && json?.initialised === true && json?.version === version && typeof m === 'string' && accept.includes(m)
}

export const errCode = (j: Json | null): string | null => ((j?.error as Json | undefined)?.code as string | undefined) ?? null

export interface KeylessCheck {
  name: string
  path: string
  /** The whole `Authorization` header value, when the check sends one (never a key). */
  authorization?: string
  ok(status: number, json: Json | null): boolean
}

/** The checks after `/health` that need no key: the old root document is gone, and every unauthenticated or malformed bearer is a 401. */
export const ROOT_DOC_CHECK: KeylessCheck = { name: 'GET /openapi.json -> 404 not_found (no root document)', path: '/openapi.json', ok: (s, j) => s === 404 && errCode(j) === 'not_found' }
export const NO_AUTH_CHECK: KeylessCheck = { name: 'no Authorization -> 401', path: '/api/v1/tasks', ok: (s) => s === 401 }
export const MALFORMED_KEY_CHECK: KeylessCheck = { name: 'Bearer vk_malformed -> 401', path: '/api/v1/tasks', authorization: 'Bearer vk_malformed', ok: (s) => s === 401 }
export const JWT_SHAPE_CHECK: KeylessCheck = { name: 'Bearer a.b.c -> 401', path: '/api/v1/tasks', authorization: 'Bearer a.b.c', ok: (s) => s === 401 }

export interface CheckOutcome {
  name: string
  ok: boolean
  detail?: unknown
}

async function get(fetchFn: typeof fetch, base: string, path: string, authorization?: string): Promise<{ status: number; json: Json | null }> {
  const res = await fetchFn(base + path, { method: 'GET', headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(15_000) })
  const text = await res.text()
  try {
    return { status: res.status, json: text ? (JSON.parse(text) as Json) : null }
  } catch {
    return { status: res.status, json: null }
  }
}

/** Runs `/health` (after-phase meaning, `accept` for the migrations status) and the key-less checks against `base` (`https://<api_host>`). A network failure is a failed check. */
export async function keylessChecks(base: string, version: string, accept: readonly string[], fetchFn: typeof fetch): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = []
  const run = async (name: string, path: string, ok: (s: number, j: Json | null) => boolean, authorization?: string) => {
    try {
      const r = await get(fetchFn, base, path, authorization)
      out.push({ name, ok: ok(r.status, r.json), detail: { status: r.status, code: errCode(r.json) } })
    } catch (e) {
      out.push({ name, ok: false, detail: { error: e instanceof Error ? e.message : 'request failed' } })
    }
  }
  await run('health -> 200 ok, initialised true, version, migrations ' + accept.join(' or '), '/health', (s, j) => afterHealthOk(s, j, version, accept))
  for (const c of [ROOT_DOC_CHECK, NO_AUTH_CHECK, MALFORMED_KEY_CHECK, JWT_SHAPE_CHECK]) await run(c.name, c.path, c.ok, c.authorization)
  return out
}
