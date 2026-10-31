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
import { Miniflare } from 'miniflare'
import { hashApiKey, messageContentPrefix, messageBodyKey, fileBlobKey, type R2BucketLike } from '@vault/api'
import { applyMigrations, createMigrationTracker, recordMigrations } from '@vault/storage-d1/test'
import { MIGRATIONS, type D1Like } from '@vault/storage-d1'
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

/** Every line Miniflare and the Worker's console print (workerd's stdout and stderr), kept for the secret-absence check. */
const logLines: string[] = []
const capture = (stream: NodeJS.ReadableStream) => {
  let rest = ''
  stream.on('data', (chunk: Buffer) => {
    const parts = (rest + chunk.toString()).split('\n')
    rest = parts.pop() ?? ''
    logLines.push(...parts)
  })
  stream.on('end', () => rest && logLines.push(rest))
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
    r2Buckets: ['BODIES'],
    handleRuntimeStdio: (stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream) => {
      capture(stdout)
      capture(stderr)
    },
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
  res = await call('GET', '/api/v1/tasks', { token: 'vk_anything' })
  body = await json(res)
  check('2 GET /api/v1/tasks before bootstrap -> 503 not_initialised', res.status === 503 && body.error?.code === 'not_initialised', { status: res.status, body })

  // 2a: the two OpenAPI documents are served before initialisation; the old root document is not exempt ([[API32]] D4, D5)
  for (const [path, title] of [['/api/v1/openapi.json', 'Vault records API'], ['/meta/v1/openapi.json', 'Vault meta API']] as const) {
    res = await call('GET', path)
    body = await json(res)
    check(`2a GET ${path} before bootstrap -> 200, ${title}`, res.status === 200 && body.openapi === '3.1.0' && body.info?.title === title, { status: res.status })
  }

  // 3: the local bootstrap, through the same code the CLI uses
  const boot = await bootstrapD1(d1, { organizationName: 'Smoke', email: 'owner@smoke.test', agentName: 'smoke-bot', authOrgId: 'org_smoke', authSubject: 'user_owner' })
  check('3 bootstrapD1 -> a vk_ key and the marker', boot.key.startsWith('vk_') && boot.deployment === 'created', { prefix: boot.key.slice(0, 7), deployment: boot.deployment })
  const key = boot.key

  res = await call('GET', '/health')
  body = await json(res)
  check('4 GET /health after bootstrap -> initialised true', res.status === 200 && body.initialised === true, { status: res.status, body })
  const unknownState = (body.migrations ?? {}) as { status?: string; expected?: number; applied?: number }
  check('4a /health.migrations is unknown without a wrangler tracker (workerd reads the real binding)', unknownState.status === 'unknown' && unknownState.applied === 0 && unknownState.expected === MIGRATIONS.length, body.migrations)
  await createMigrationTracker(d1)
  await recordMigrations(d1, MIGRATIONS.map((m) => m.name))
  await new Promise((resolve) => setTimeout(resolve, 5_200)) // the Worker re-reads an unknown state after 5 s (CORE61 D6)
  res = await call('GET', '/health')
  body = await json(res)
  check('4b /health.migrations is current once the tracker is filled', (body.migrations as { status?: string } | undefined)?.status === 'current', body.migrations)

  res = await call('GET', '/api/v1/tasks', { token: key })
  body = await json(res)
  check('5 GET /api/v1/tasks with the key -> 200', res.status === 200 && Array.isArray(body.data), { status: res.status, body })

  // 6: a task lifecycle with three events
  const eventsBefore = await count('events')
  const created = await call('POST', '/api/v1/tasks', { token: key, body: { title: 'smoke task' } })
  const task = await json(created)
  const patched = await call('PATCH', `/api/v1/tasks/${task.id}`, { token: key, body: { title: 'renamed' } })
  const deleted = await call('DELETE', `/api/v1/tasks/${task.id}`, { token: key })
  const events = (await count('events')) - eventsBefore
  check('6 POST/PATCH/DELETE /api/v1/tasks -> 201/200/204 and three events', created.status === 201 && patched.status === 200 && deleted.status === 204 && events === 3, {
    statuses: [created.status, patched.status, deleted.status],
    events,
  })

  // 6a: the old root paths are gone ([[API32]] D5, D8)
  for (const path of ['/openapi.json', '/tasks']) {
    res = await call('GET', path, { token: key })
    body = await json(res)
    check(`6a GET ${path} -> 404 not_found`, res.status === 404 && body.error?.code === 'not_found', { status: res.status, body })
  }

  // 7: agents:read is not agent-grantable
  res = await call('GET', '/meta/v1/agents', { token: key })
  body = await json(res)
  check('7 GET /meta/v1/agents with the key -> 403 insufficient_scope', res.status === 403 && body.error?.code === 'insufficient_scope', { status: res.status, body })

  // 7a: schema discovery under workerd's D1 (pragma table-valued functions), API63
  res = await call('GET', '/meta/v1/schema', { token: key })
  body = await json(res)
  const names: string[] = Array.isArray(body.tables) ? body.tables.map((t: { name: string }) => t.name) : []
  const contacts = Array.isArray(body.tables) ? body.tables.find((t: { name: string }) => t.name === 'contacts') : undefined
  const companyId = contacts?.columns?.find((c: { name: string }) => c.name === 'company_id')
  check(
    '7a GET /meta/v1/schema with the key -> 200, d1, sorted, notes present, deployment hidden, contacts.company_id -> companies.id',
    res.status === 200 &&
      body.engine === 'd1' &&
      names.includes('notes') &&
      names.includes('associations') &&
      !names.includes('deployment') &&
      !names.includes('unit_assertion') &&
      names.join() === [...names].sort().join() &&
      companyId?.references?.table === 'companies' &&
      companyId?.references?.column === 'id',
    { status: res.status, names },
  )

  // 8: resolve two emails, then merge two contacts
  res = await call('POST', '/api/v1/identities/resolve', {
    token: key,
    body: { identities: [{ kind: 'email', value: 'a@smoke.test', name: 'A' }, { kind: 'email', value: 'b@smoke.test', name: 'B' }] },
  })
  body = await json(res)
  const resolved = res.status === 200 && body.data?.length === 2
  const c1 = await json(await call('POST', '/api/v1/contacts', { token: key, body: { name: 'Survivor' } }))
  const c2 = await json(await call('POST', '/api/v1/contacts', { token: key, body: { name: 'Source' } }))
  const merged = await call('POST', `/api/v1/contacts/${c1.id}/merge`, { token: key, body: { source_id: c2.id } })
  check('8 POST /api/v1/identities/resolve then /contacts/{a}/merge -> 200, merged', resolved && merged.status === 200, { resolve: res.status, merge: merged.status })

  // 9-10: Clerk users
  const ownerToken = await mintClerkToken(issuer, { sub: 'user_owner', extra: orgClaim('org_smoke') })
  res = await call('GET', '/meta/v1/me', { token: ownerToken })
  body = await json(res)
  check('9 GET /meta/v1/me as the linked owner -> 200, one membership', res.status === 200 && body.memberships?.length === 1, { status: res.status, body })

  const eventsBeforeFirstSight = await count('events')
  const newToken = await mintClerkToken(issuer, { sub: 'user_new' })
  res = await call('GET', '/meta/v1/me', { token: newToken })
  body = await json(res)
  check('10 GET /meta/v1/me as user_new -> 200, first sight with no event', res.status === 200 && (await count('events')) === eventsBeforeFirstSight && body.user?.email === 'new@smoke.test', { status: res.status, body })

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
  res = await call('GET', '/meta/v1/me', { token: otherToken })
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
  const logText = logLines.join('\n')
  // The capture must be live, or the absence below proves nothing: check 14's Worker log line has to be in it.
  const captured = logText.includes('[directory] snapshot over the set limit')
  check('15 no event row and no Worker log line contains the key or its hash (capture seen live)', captured && !eventText.includes(key) && !eventText.includes(keyHash) && !logText.includes(key) && !logText.includes(keyHash), {
    captureLive: captured,
    lines: logLines.length,
    inEvents: eventText.includes(key) || eventText.includes(keyHash),
    inLog: logText.includes(key) || logText.includes(keyHash),
  })

  // 16: the network guard
  check('16 the Worker reached only the fake Clerk host', hostsSeen.size > 0 && [...hostsSeen].every((h) => h === API_URL), [...hostsSeen])

  // 17-19: message content and file bytes from workerd's real R2 binding (CORE58)
  const bodies = (await mf.getR2Bucket('BODIES')) as unknown as R2BucketLike
  const org = String((await rows('select organization_id as o from deployment'))[0]!.o)
  const by = String((await rows('select id from principals limit 1'))[0]!.id)
  const at = '2026-10-30T09:00:00.000Z'
  const sha = 'a'.repeat(64)
  const thread = crypto.randomUUID()
  await d1.prepare('insert into threads (id, organization_id, created_by, created_at, channel, subject) values (?, ?, ?, ?, ?, ?)').bind(thread, org, by, at, 'email', 'Smoke').run()
  const addMessage = async (externalId: string) => {
    const id = crypto.randomUUID()
    const contentKey = await messageContentPrefix(org, 'email', externalId)
    await d1
      .prepare(
        `insert into messages (id, organization_id, created_by, created_at, thread_id, channel, kind, external_id, author, occurred_at, preview, content_key, version) values (?, ?, ?, ?, ?, 'email', 'message', ?, ?, ?, 'Smoke', ?, 1)`,
      )
      .bind(id, org, by, at, thread, externalId, JSON.stringify({ user_id: 'j@smoke.test', user_name: 'j@smoke.test', full_name: 'J', is_bot: false }), at, contentKey)
      .run()
    return { id, contentKey }
  }
  const withBody = await addMessage('smoke-1@smoke.test')
  const withoutBody = await addMessage('smoke-2@smoke.test')
  await bodies.put(messageBodyKey(withBody.contentKey, 1), '# Smoke body')
  const fileId = crypto.randomUUID()
  const storageKey = `orgs/${org}/files/${fileId}`
  await d1
    .prepare(`insert into files (id, organization_id, created_by, created_at, name, mime_type, size_bytes, sha256, storage_key) values (?, ?, ?, ?, 'smoke.pdf', 'application/pdf', 256, ?, ?)`)
    .bind(fileId, org, by, at, sha, storageKey)
    .run()
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
  await bodies.put(fileBlobKey(storageKey), bytes)

  res = await call('GET', `/api/v1/messages/${withBody.id}/content`, { token: key })
  body = await json(res)
  check('17 GET /api/v1/messages/{id}/content -> 200 markdown', res.status === 200 && body.content === '# Smoke body' && body.content_type === 'text/markdown' && body.version === 1, { status: res.status, body })

  res = await call('GET', `/api/v1/files/${fileId}/content`, { token: key })
  const got = new Uint8Array(await res.arrayBuffer())
  check(
    '18 GET /api/v1/files/{id}/content -> 200, exact bytes, nosniff, sandbox, attachment',
    res.status === 200 &&
      got.length === 256 &&
      got.every((b, i) => b === i) &&
      res.headers.get('x-content-type-options') === 'nosniff' &&
      res.headers.get('content-security-policy') === 'sandbox' &&
      (res.headers.get('content-disposition') ?? '').startsWith('attachment;'),
    { status: res.status, bytes: got.length, headers: Object.fromEntries(res.headers) },
  )

  res = await call('GET', `/api/v1/messages/${withoutBody.id}/content`, { token: key })
  body = await json(res)
  check('19 GET /api/v1/messages/{id}/content without its object -> 404 content_unavailable', res.status === 404 && body.error?.code === 'content_unavailable', { status: res.status, body })
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
