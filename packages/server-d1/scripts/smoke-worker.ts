// End-to-end smoke of the open D1 Worker ([[CORE38]] D8, P9). It bundles `src/worker.ts` with esbuild exactly as a deploy
// would, loads the bundle in workerd through Miniflare against a fresh in-memory D1, and drives the real app over HTTP.
// Everything is local: the only outbound host the Worker may reach is the fake Clerk Backend API, answered by an
// `outboundService` function; any other host fails the smoke (check 16), which proves the run made no real network call.
//
//   pnpm -C packages/server-d1 smoke:worker
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Log, LogLevel, Miniflare } from 'miniflare'
import { hashApiKey } from '@vault/api'
import { applyMigrations } from '@vault/storage-d1/test'
import type { D1Like } from '@vault/storage-d1'
import {
  API_URL,
  SECRET_KEY,
  WEBHOOK_SECRET,
  clerkMembership,
  clerkOrganization,
  clerkUser,
  clerkWebhook,
  fakeClerkFetch,
  mintClerkToken,
  orgClaim,
  signClerkWebhook,
  testIssuer,
} from '@vault/api/test/clerk'
import { bootstrapD1 } from '../src/bootstrap-d1.js'

let failures = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

/** Captures every line Miniflare prints, which includes the Worker's own console output. */
class CaptureLog extends Log {
  readonly lines: string[] = []
  constructor() {
    super(LogLevel.DEBUG)
  }
  override logWithLevel(_level: LogLevel, message: string): void {
    this.lines.push(message)
  }
}

const workerDir = mkdtempSync(join(tmpdir(), 'vault-d1-worker-'))
const bundle = join(workerDir, 'worker.mjs')
const entry = fileURLToPath(new URL('../src/worker.ts', import.meta.url))

const issuer = await testIssuer()
const profiles = new Map([['user_new', clerkUser({ id: 'user_new', email: 'new@smoke.test' })]])
const organizations = new Map([['org_smoke', clerkOrganization({ id: 'org_smoke', name: 'Smoke' })]])
const members = new Map([['org_smoke', [clerkMembership({ organizationId: 'org_smoke', userId: 'user_owner', role: 'org:admin' })]]])
const clerk = fakeClerkFetch(profiles, { organizations, members })
const hostsSeen = new Set<string>()
const log = new CaptureLog()
let mf: Miniflare | undefined

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    target: 'es2022',
    outfile: bundle,
    logLevel: 'warning',
  })
  console.log(`bundle ${statSync(bundle).size} bytes (${bundle})`)

  mf = new Miniflare({
    modules: true,
    scriptPath: bundle,
    modulesRoot: workerDir,
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: `smoke-${crypto.randomUUID()}` },
    d1Persist: false,
    log,
    bindings: {
      AUTH_PROVIDER: 'clerk',
      CLERK_JWT_KEY: issuer.pem,
      CLERK_ISSUER: issuer.issuer,
      CLERK_AUTHORIZED_PARTIES: issuer.party,
      CLERK_SECRET_KEY: SECRET_KEY,
      CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET,
      CLERK_API_URL: API_URL,
      CORS_ALLOWED_ORIGINS: '',
    },
    outboundService: async (req: Request) => {
      const url = new URL(req.url)
      hostsSeen.add(url.origin)
      if (url.origin !== API_URL) return new Response('blocked by the smoke: not the fake Clerk host', { status: 502 })
      return clerk(req.url, { headers: req.headers, method: req.method })
    },
  })
  const base = await mf.ready
  const d1 = (await mf.getD1Database('DB')) as unknown as D1Like
  await applyMigrations(d1)

  const call = (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) =>
    fetch(new URL(path, base), {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    })
  const json = async (res: Response): Promise<any> => {
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text.slice(0, 200) }
    }
  }
  const rows = async (sqlText: string, ...binds: unknown[]) => ((await d1.prepare(sqlText).bind(...binds).all()).results ?? []) as Array<Record<string, unknown>>
  const count = async (table: string) => Number((await rows(`select count(*) as n from "${table}"`))[0]!.n)

  // 1-2: before bootstrap
  let res = await call('GET', '/health')
  let body = await json(res)
  check('1 GET /health before bootstrap -> 200 initialised false', res.status === 200 && body.status === 'ok' && body.initialised === false, { status: res.status, body })
  res = await call('GET', '/tasks', { token: 'vk_anything' })
  body = await json(res)
  check('2 GET /tasks before bootstrap -> 503 not_initialised', res.status === 503 && body.error?.code === 'not_initialised', { status: res.status, body })

  // 3: the local bootstrap, through the same code the CLI uses
  const boot = await bootstrapD1(d1, { organizationName: 'Smoke', email: 'owner@smoke.test', agentName: 'smoke-bot', authOrgId: 'org_smoke', authSubject: 'user_owner' })
  check('3 bootstrapD1 -> a vk_ key and the marker', boot.key.startsWith('vk_') && boot.deployment === 'created', { prefix: boot.key.slice(0, 7), deployment: boot.deployment })
  const key = boot.key

  res = await call('GET', '/health')
  body = await json(res)
  check('4 GET /health after bootstrap -> initialised true', res.status === 200 && body.initialised === true, { status: res.status, body })

  res = await call('GET', '/tasks', { token: key })
  body = await json(res)
  check('5 GET /tasks with the key -> 200', res.status === 200 && Array.isArray(body.data), { status: res.status, body })

  // 6: a task lifecycle with three events
  const eventsBefore = await count('events')
  const created = await call('POST', '/tasks', { token: key, body: { title: 'smoke task' } })
  const task = await json(created)
  const patched = await call('PATCH', `/tasks/${task.id}`, { token: key, body: { title: 'renamed' } })
  const deleted = await call('DELETE', `/tasks/${task.id}`, { token: key })
  const events = (await count('events')) - eventsBefore
  check('6 POST/PATCH/DELETE /tasks -> 201/200/204 and three events', created.status === 201 && patched.status === 200 && deleted.status === 204 && events === 3, {
    statuses: [created.status, patched.status, deleted.status],
    events,
  })

  // 7: agents:read is not agent-grantable
  res = await call('GET', '/agents', { token: key })
  body = await json(res)
  check('7 GET /agents with the key -> 403 insufficient_scope', res.status === 403 && body.error?.code === 'insufficient_scope', { status: res.status, body })

  // 8: resolve two emails, then merge two contacts
  res = await call('POST', '/identities/resolve', {
    token: key,
    body: { identities: [{ kind: 'email', value: 'a@smoke.test', name: 'A' }, { kind: 'email', value: 'b@smoke.test', name: 'B' }] },
  })
  body = await json(res)
  const resolved = res.status === 200 && body.data?.length === 2
  const c1 = await json(await call('POST', '/contacts', { token: key, body: { name: 'Survivor' } }))
  const c2 = await json(await call('POST', '/contacts', { token: key, body: { name: 'Source' } }))
  const merged = await call('POST', `/contacts/${c1.id}/merge`, { token: key, body: { source_id: c2.id } })
  check('8 POST /identities/resolve then /contacts/{a}/merge -> 200, merged', resolved && merged.status === 200, { resolve: res.status, merge: merged.status })

  // 9-10: Clerk users
  const ownerToken = await mintClerkToken(issuer, { sub: 'user_owner', extra: orgClaim('org_smoke') })
  res = await call('GET', '/me', { token: ownerToken })
  body = await json(res)
  check('9 GET /me as the linked owner -> 200, one membership', res.status === 200 && body.memberships?.length === 1, { status: res.status, body })

  const eventsBeforeFirstSight = await count('events')
  const newToken = await mintClerkToken(issuer, { sub: 'user_new' })
  res = await call('GET', '/me', { token: newToken })
  body = await json(res)
  check('10 GET /me as user_new -> 200, first sight with no event', res.status === 200 && (await count('events')) === eventsBeforeFirstSight && body.user?.email === 'new@smoke.test', { status: res.status, body })

  // 11: a membership webhook reconciles the organisation
  members.set('org_smoke', [
    clerkMembership({ organizationId: 'org_smoke', userId: 'user_owner', role: 'org:admin' }),
    clerkMembership({ organizationId: 'org_smoke', userId: 'user_new', role: 'org:member' }),
  ])
  let signed = signClerkWebhook(clerkWebhook('organizationMembership.created', { id: 'orgmem_new', organization: { id: 'org_smoke' }, public_user_data: { user_id: 'user_new' } }))
  res = await call('POST', '/webhooks/clerk', { headers: signed.headers, raw: signed.body })
  const live = await rows(
    `select u.auth_subject as s from memberships m join users u on u.id = m.user_id where m.deleted_at is null order by u.auth_subject`,
  )
  check('11 signed organizationMembership.created -> 200 and user_new is a member', res.status === 200 && live.map((r) => r.s).join() === 'user_new,user_owner', { status: res.status, live })

  // 12: a webhook for another organisation is acknowledged without a fetch
  const callsBefore = clerk.calls.length
  signed = signClerkWebhook(clerkWebhook('organization.updated', { id: 'org_other' }))
  res = await call('POST', '/webhooks/clerk', { headers: signed.headers, raw: signed.body })
  body = await json(res)
  check('12 signed webhook for org_other -> 200 received, no Clerk call for it', res.status === 200 && body.received === true && clerk.calls.slice(callsBefore).every((c) => !c.url.includes('org_other')), { status: res.status, body })

  // 13: a token claiming another organisation
  const otherToken = await mintClerkToken(issuer, { sub: 'user_owner', extra: orgClaim('org_other') })
  res = await call('GET', '/me', { token: otherToken })
  body = await json(res)
  check('13 token claiming org_other -> 403 organization_forbidden', res.status === 403 && body.error?.code === 'organization_forbidden', { status: res.status, body })

  // 14: more members than the set cap
  const membersBefore = await count('memberships')
  members.set(
    'org_smoke',
    Array.from({ length: 101 }, (_, i) => clerkMembership({ organizationId: 'org_smoke', userId: `user_bulk_${i}`, role: 'org:member' })),
  )
  signed = signClerkWebhook(clerkWebhook('organization.updated', { id: 'org_smoke' }))
  res = await call('POST', '/webhooks/clerk', { headers: signed.headers, raw: signed.body })
  body = await json(res)
  check('14 101 members then a webhook -> 400 set_limit_exceeded, memberships unchanged', res.status === 400 && body.error?.code === 'set_limit_exceeded' && (await count('memberships')) === membersBefore, {
    status: res.status,
    body,
  })

  // 15: secret absence
  const keyHash = await hashApiKey(key)
  const eventText = JSON.stringify(await rows('select * from events'))
  const logText = log.lines.join('\n')
  check('15 no event row and no Worker log line contains the key or its hash', !eventText.includes(key) && !eventText.includes(keyHash) && !logText.includes(key) && !logText.includes(keyHash), {
    inEvents: eventText.includes(key) || eventText.includes(keyHash),
    inLog: logText.includes(key) || logText.includes(keyHash),
  })

  // 16: the network guard
  check('16 the Worker reached only the fake Clerk host', hostsSeen.size > 0 && [...hostsSeen].every((h) => h === API_URL), [...hostsSeen])
} catch (err) {
  failures++
  console.log(`FAIL smoke aborted -> ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await mf?.dispose()
  rmSync(workerDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks ok')
