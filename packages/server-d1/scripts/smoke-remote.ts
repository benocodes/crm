// Smoke of a deployed instance ([[OPS4]] C9):
//   pnpm -C packages/server-d1 smoke:remote -- --base <url> --phase before|after --expect-version <sha>
// Phase `after` reads the operator key from VAULT_SMOKED1_OPERATOR_KEY (root .env); the key is only ever placed in the
// `authorization` header and failure details print a status and an error code, never a header or a body.
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { RemoteRefusal, loadRootEnv } from './remote.js'

export function percentile(sortedMs: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sortedMs.length))
  return sortedMs[Math.min(rank, sortedMs.length) - 1]!
}

export function parseSmokeArgs(argv: string[]): { base: string; phase: 'before' | 'after'; expectVersion: string } {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: { base: { type: 'string' }, phase: { type: 'string' }, 'expect-version': { type: 'string' } },
    strict: true,
  })
  if (!values.base || !values['expect-version']) throw new Error('--base and --expect-version are required')
  if (values.phase !== 'before' && values.phase !== 'after') throw new Error('--phase must be before or after')
  return { base: values.base.replace(/\/+$/, ''), phase: values.phase, expectVersion: values['expect-version'] }
}

let failed = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
}

type Json = Record<string, unknown>
async function call(base: string, method: string, path: string, key?: string | null, body?: unknown, rawAuth?: string) {
  const headers: Record<string, string> = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (rawAuth) headers.authorization = rawAuth
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json: Json | null = null
  try {
    json = text ? (JSON.parse(text) as Json) : null
  } catch {
    json = null
  }
  return { status: res.status, json }
}
const errCode = (j: Json | null) => ((j?.error as Json | undefined)?.code as string | undefined) ?? null

async function before(base: string, version: string): Promise<void> {
  const h = await call(base, 'GET', '/health')
  check('health -> 200 ok, initialised false, version', h.status === 200 && h.json?.status === 'ok' && h.json?.initialised === false && h.json?.version === version, { status: h.status, initialised: h.json?.initialised, version: h.json?.version })
  const t = await call(base, 'GET', '/api/v1/tasks')
  check('GET /api/v1/tasks (no auth) -> 503 not_initialised', t.status === 503 && errCode(t.json) === 'not_initialised', { status: t.status, code: errCode(t.json) })
  for (const [path, title] of [['/api/v1/openapi.json', 'Vault records API'], ['/meta/v1/openapi.json', 'Vault meta API']] as const) {
    const o = await call(base, 'GET', path)
    check(`GET ${path} -> 200, openapi 3.1.0, ${title}`, o.status === 200 && o.json?.openapi === '3.1.0' && (o.json?.info as Json | undefined)?.title === title, { status: o.status })
  }
  const root = await call(base, 'GET', '/openapi.json')
  check('GET /openapi.json -> 404 not_found (no root document)', root.status === 404 && errCode(root.json) === 'not_found', { status: root.status, code: errCode(root.json) })
}

/** The `after` health check: initialised, the expected version, and every core migration applied ([[CORE61]] D7). */
export function afterHealthOk(status: number, json: Json | null, version: string): boolean {
  return status === 200 && json?.initialised === true && json?.version === version && (json?.migrations as Json | undefined)?.status === 'current'
}

async function after(base: string, version: string, key: string): Promise<void> {
  const h = await call(base, 'GET', '/health')
  check('health -> 200 ok, initialised true, version, migrations current', afterHealthOk(h.status, h.json, version), { status: h.status, initialised: h.json?.initialised, version: h.json?.version, migrations: h.json?.migrations })
  const list = await call(base, 'GET', '/api/v1/tasks', key)
  check('GET /api/v1/tasks with the key -> 200, data array', list.status === 200 && Array.isArray(list.json?.data), { status: list.status })
  const none = await call(base, 'GET', '/api/v1/tasks')
  check('no Authorization -> 401', none.status === 401, { status: none.status })
  const mal = await call(base, 'GET', '/api/v1/tasks', null, undefined, 'Bearer vk_malformed')
  check('Bearer vk_malformed -> 401', mal.status === 401, { status: mal.status })
  const jwt = await call(base, 'GET', '/api/v1/tasks', null, undefined, 'Bearer a.b.c')
  check('Bearer a.b.c -> 401', jwt.status === 401, { status: jwt.status })

  const title = `smoke-${version}`
  const created = await call(base, 'POST', '/api/v1/tasks', key, { title })
  const id = (created.json?.id as string | undefined) ?? ''
  check('POST /api/v1/tasks -> 201', created.status === 201 && id !== '', { status: created.status })
  if (id) {
    const got = await call(base, 'GET', `/api/v1/tasks/${id}`, key)
    check('GET /api/v1/tasks/<id> -> 200 with the title', got.status === 200 && got.json?.title === title, { status: got.status })
    const del = await call(base, 'DELETE', `/api/v1/tasks/${id}`, key)
    check('DELETE /api/v1/tasks/<id> -> 204', del.status === 204, { status: del.status })
    const gone = await call(base, 'GET', `/api/v1/tasks/${id}`, key)
    check('GET /api/v1/tasks/<id> after delete -> 404 not_found', gone.status === 404 && errCode(gone.json) === 'not_found', { status: gone.status, code: errCode(gone.json) })
  }

  const total = 200
  const concurrency = 20
  const times: number[] = []
  let bad = 0
  let errors = 0
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        next++
        const t0 = performance.now()
        try {
          const r = await fetch(base + '/api/v1/tasks', { headers: { authorization: `Bearer ${key}` } })
          await r.arrayBuffer()
          if (r.status < 200 || r.status > 299) bad++
        } catch {
          errors++
        }
        times.push(performance.now() - t0)
      }
    }),
  )
  times.sort((a, b) => a - b)
  check(`load: ${total} GET /api/v1/tasks at concurrency ${concurrency}: zero non-2xx, zero errors`, bad === 0 && errors === 0, { non2xx: bad, errors })
  console.log(`load: p50=${percentile(times, 50).toFixed(0)}ms p95=${percentile(times, 95).toFixed(0)}ms max=${times[times.length - 1]!.toFixed(0)}ms`)
}

async function main(): Promise<void> {
  const args = parseSmokeArgs(process.argv.slice(2))
  if (args.phase === 'before') await before(args.base, args.expectVersion)
  else {
    loadRootEnv()
    const key = process.env.VAULT_SMOKED1_OPERATOR_KEY
    if (!key) throw new RemoteRefusal('VAULT_SMOKED1_OPERATOR_KEY must be set in .env for --phase after')
    await after(args.base, args.expectVersion, key)
  }
  if (failed > 0) {
    console.log(`${failed} check(s) FAILED`)
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main()
  } catch (err) {
    console.error(`smoke-remote: ${err instanceof Error ? err.message : 'failed'}`)
    process.exitCode = 1
  }
}
