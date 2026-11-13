// The AGT165 E2E on a deployed instance (the charter's steps 3 to 5), after the branch is migrated and deployed:
//   pnpm -C packages/server-d1 e2e:rail -- --base https://api.smoked1.vibase.ai --expect-version <sha> [--wait-seconds 240]
// It proposes `tasks.create` with an `expires_at` two minutes ahead, polls the request once a minute until the per-minute cron expires it, and checks what
// the cron did: the request is `expired`, decided by the system principal, no task of that title exists, and the execution list is empty (no enqueued
// operation is registered in production before #166). The key is read from the root `.env`: VAULT_SMOKED1_RAIL_KEY (an agent holding tasks:request_approval,
// tasks:read and action_requests:read), else VAULT_SMOKED1_OPERATOR_KEY. It only ever sits in the `authorization` header; no body or key is printed.
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { RemoteRefusal, loadRootEnv } from './remote.js'

type Json = Record<string, unknown>
let failed = 0
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
}
async function call(base: string, method: string, path: string, key: string | null, body?: unknown): Promise<{ status: number; json: Json | null }> {
  const headers: Record<string, string> = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  try {
    return { status: res.status, json: text ? (JSON.parse(text) as Json) : null }
  } catch {
    return { status: res.status, json: null }
  }
}
const errCode = (j: Json | null) => ((j?.error as Json | undefined)?.code as string | undefined) ?? null

export function parseArgsOf(argv: string[]): { base: string; expectVersion: string; waitSeconds: number } {
  const { values } = parseArgs({ args: argv.filter((a) => a !== '--'), options: { base: { type: 'string' }, 'expect-version': { type: 'string' }, 'wait-seconds': { type: 'string' } }, strict: true })
  if (!values.base || !values['expect-version']) throw new Error('--base and --expect-version are required')
  return { base: values.base.replace(/\/+$/, ''), expectVersion: values['expect-version'], waitSeconds: Number(values['wait-seconds'] ?? 240) }
}

/** The key of the smoked1 rail check: the rail agent's, else the operator's ([[OPS265]] D15). */
export function railKeyOf(env: NodeJS.ProcessEnv): string {
  const key = env.VAULT_SMOKED1_RAIL_KEY || env.VAULT_SMOKED1_OPERATOR_KEY
  if (!key) throw new RemoteRefusal('VAULT_SMOKED1_RAIL_KEY or VAULT_SMOKED1_OPERATOR_KEY must be set in .env')
  return key
}

async function main(): Promise<void> {
  const args = parseArgsOf(process.argv.slice(2))
  loadRootEnv()
  const key = railKeyOf(process.env)
  const { base } = args

  const health = await call(base, 'GET', '/health', null)
  const migrations = health.json?.migrations as Json | undefined
  check('health: the branch is deployed and the database is current', health.status === 200 && health.json?.version === args.expectVersion && migrations?.status === 'current' && migrations?.latest_applied === '0012_action_executions.sql', { status: health.status, version: health.json?.version, migrations })

  const title = `E2E expiry ${Date.now()}`
  const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString()
  const created = await call(base, 'POST', '/api/v1/action-requests', key, { operation: 'tasks.create', arguments: { title }, reason: 'AGT165 E2E: the per-minute cron must expire this', expires_at: expiresAt })
  const id = (created.json?.id as string | undefined) ?? ''
  check('POST /api/v1/action-requests -> 201 pending', created.status === 201 && created.json?.status === 'pending' && id !== '', { status: created.status, code: errCode(created.json) })
  if (!id) {
    console.log('The key cannot propose tasks.create (needs tasks:request_approval or tasks:write); set VAULT_SMOKED1_RAIL_KEY to an agent that holds tasks:request_approval, tasks:read and action_requests:read.')
    process.exitCode = 1
    return
  }

  const deadline = Date.now() + args.waitSeconds * 1000
  let last: Json | null = null
  let status = 0
  while (Date.now() < deadline) {
    const got = await call(base, 'GET', `/api/v1/action-requests/${id}`, key)
    status = got.status
    last = got.json
    console.log(`poll ${new Date().toISOString()}: ${got.status} ${String(got.json?.status ?? errCode(got.json))}`)
    if (got.status !== 200 || got.json?.status !== 'pending') break
    await new Promise((r) => setTimeout(r, 30_000))
  }
  check('step 4: the request is expired within four minutes', status === 200 && last?.status === 'expired', { status, state: last?.status, code: errCode(last) })
  check('step 4: decided_by is set and decided_at is not before expires_at', typeof last?.decided_by === 'string' && typeof last?.decided_at === 'string' && Date.parse(String(last.decided_at)) >= Date.parse(expiresAt), { decided_by: last?.decided_by, decided_at: last?.decided_at })
  const tasks = await call(base, 'GET', '/api/v1/tasks?limit=200', key)
  const data = (tasks.json?.data as Json[] | undefined) ?? []
  check('no task titled with the E2E title exists', tasks.status === 200 && !data.some((t) => t.title === title), { status: tasks.status })
  const executions = await call(base, 'GET', '/api/v1/action-executions', key)
  check('step 5: GET /api/v1/action-executions -> 200 with an empty list', executions.status === 200 && Array.isArray(executions.json?.data) && (executions.json?.data as unknown[]).length === 0, { status: executions.status })
  if (failed > 0) {
    console.log(`${failed} check(s) FAILED`)
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main()
  } catch (err) {
    console.error(err instanceof RemoteRefusal ? `refused: ${err.message}` : `failed: ${err instanceof Error ? err.message : 'error'}`)
    process.exitCode = 1
  }
}
