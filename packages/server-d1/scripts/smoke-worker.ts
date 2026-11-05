// End-to-end smoke of the open D1 Worker ([[CORE38]] D8, P9). It bundles `src/worker.ts` with esbuild exactly as a deploy
// would, loads the bundle in workerd through Miniflare against a fresh in-memory D1, and drives the real app over HTTP.
// Everything is local: the only outbound host the Worker may reach is the fake Clerk Backend API, answered by an
// `outboundService` function; any other host fails the smoke (check 16), which proves the run made no real network call.
//
//   pnpm -C packages/server-d1 smoke:worker
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { createHash } from 'node:crypto'
import { hashApiKey, messageContentPrefix, messageBodyKey, fileBlobKey, type R2BucketLike } from '@vault/api'
import { bytesOf } from '@vault/api/test/channels'
import { ATTACHMENT_BYTES, GMAIL_ATTACHMENT_SEED, ORIGINAL_BYTES } from './smoke-pipeline-sizes.js'
import { applyMigrations, createMigrationTracker, recordMigrations } from '@vault/storage-d1/test'
import { MIGRATIONS, type D1Like } from '@vault/storage-d1'
import {
  API_URL,
  SECRET_KEY,
  clerkUser,
  fakeClerkFetch,
  mintClerkToken,
  orgClaim,
  testIssuer,
} from '@vault/api/test/clerk'
import { bootstrapD1 } from '../src/bootstrap-d1.js'
import { buildConnect } from './build-connect.js'

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
const assetsDir = join(workerDir, 'assets')
const entry = fileURLToPath(new URL('../src/worker.ts', import.meta.url))

const issuer = await testIssuer()
const profiles = new Map([
  ['user_owner', clerkUser({ id: 'user_owner', email: 'owner@smoke.test' })],
  ['user_new', clerkUser({ id: 'user_new', email: 'new@smoke.test' })],
])
const clerk = fakeClerkFetch(profiles)
const hostsSeen = new Set<string>()
let mf: Miniflare | undefined
let pipelineMf: Miniflare | undefined

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
  // [[UI30]] D2, D3: a fresh build of the connect page, mounted as Workers Static Assets the way wrangler maps run_worker_first.
  await buildConnect(assetsDir)

  mf = new Miniflare({
    modules: true,
    scriptPath: bundle,
    modulesRoot: workerDir,
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: `smoke-${crypto.randomUUID()}` },
    d1Persist: false,
    r2Buckets: ['BODIES'],
    assets: { directory: assetsDir, binding: 'ASSETS', routerConfig: { has_user_worker: true, static_routing: { user_worker: ['/connect', '/connect/*'] } } },
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
  // [[CORE64]] D11: a Clerk-backed deployment creates no human; the owner arrives with a `vibase_role: owner` token
  const boot = await bootstrapD1(d1, { organizationName: 'Smoke', agentName: 'smoke-bot', authOrgId: issuer.issuer })
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

  // 9-10: Clerk session tokens carrying the workspace role ([[CORE64]] D8)
  const ownerToken = await mintClerkToken(issuer, { sub: 'user_owner', extra: { vibase_role: 'owner' } })
  res = await call('GET', '/meta/v1/me', { token: ownerToken })
  body = await json(res)
  check('9 GET /meta/v1/me as an owner by claim -> 200, one synthesised membership', res.status === 200 && body.memberships?.length === 1 && body.memberships[0].role === 'owner' && body.principal?.kind === 'user', { status: res.status, body })

  res = await call('GET', '/meta/v1/me', { token: key })
  body = await json(res)
  check('9a GET /meta/v1/me with the agent key -> 200, an agent with no user and no memberships', res.status === 200 && body.principal?.kind === 'agent' && body.user === null && body.memberships?.length === 0 && body.active_organization?.role === null, { status: res.status, body })

  const eventsBeforeFirstSight = await count('events')
  const newToken = await mintClerkToken(issuer, { sub: 'user_new', extra: { vibase_role: 'member' } })
  res = await call('GET', '/meta/v1/me', { token: newToken })
  body = await json(res)
  check('10 GET /meta/v1/me as user_new (member) -> 200, first sight with no event', res.status === 200 && (await count('events')) === eventsBeforeFirstSight && body.user?.email === 'new@smoke.test', { status: res.status, body })

  // 11: there is no webhook on the D1 Worker (D24), and no membership state
  res = await call('POST', '/webhooks/clerk', { raw: '{}' })
  check('11 POST /webhooks/clerk -> 404 and memberships is empty', res.status === 404 && (await count('memberships')) === 0, { status: res.status, memberships: await count('memberships') })

  // 12: a token without an admissible role admits nothing
  const usersBefore = await count('users')
  const noRole = await mintClerkToken(issuer, { sub: 'user_stranger' })
  res = await call('GET', '/meta/v1/me', { token: noRole })
  body = await json(res)
  check('12 token with no vibase_role -> 403 organization_forbidden, no user written', res.status === 403 && body.error?.code === 'organization_forbidden' && (await count('users')) === usersBefore, { status: res.status, body })

  // 13: an organisation claim is ignored
  const otherToken = await mintClerkToken(issuer, { sub: 'user_owner', extra: { vibase_role: 'owner', ...orgClaim('org_other') } })
  res = await call('GET', '/meta/v1/me', { token: otherToken })
  body = await json(res)
  check('13 token with an o claim for org_other and a role -> 200 (the claim is ignored)', res.status === 200 && body.active_organization?.role === 'owner', { status: res.status, body })

  // 14: the authorised party is still enforced
  const foreign = await mintClerkToken(issuer, { sub: 'user_owner', azp: 'https://evil.example', extra: { vibase_role: 'owner' } })
  res = await call('GET', '/meta/v1/me', { token: foreign })
  check('14 token with a foreign azp -> 401', res.status === 401, { status: res.status })

  // 15: secret absence
  const keyHash = await hashApiKey(key)
  const eventText = JSON.stringify(await rows('select * from events'))
  const logText = logLines.join('\n')
  // The capture must be live, or the absence below proves nothing: check 12's Worker log line has to be in it.
  const captured = logText.includes('[auth] missing or unmapped workspace role')
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

  // 20-24: the connect page from workerd's real assets binding, with the headers a deploy would send ([[UI30]] D1, D2, D9)
  const issuerOrigin = new URL(issuer.issuer).origin
  res = await call('GET', '/connect')
  const page = await res.text()
  const policy = res.headers.get('content-security-policy') ?? ''
  check(
    '20 GET /connect -> 200 HTML from a fresh build, CSP from CLERK_ISSUER, nosniff, referrer policy, no-store',
    res.status === 200 &&
      (res.headers.get('content-type') ?? '').startsWith('text/html') &&
      page.includes('/connect/connect.js') &&
      policy.includes(`script-src 'self' ${issuerOrigin} `) &&
      !/script-src[^;]*unsafe-/.test(policy) &&
      policy.includes("frame-ancestors 'none'") &&
      res.headers.get('x-content-type-options') === 'nosniff' &&
      res.headers.get('referrer-policy') === 'strict-origin-when-cross-origin' &&
      res.headers.get('cache-control') === 'no-store',
    { status: res.status, policy },
  )
  res = await fetch(new URL('/connect/', base), { redirect: 'manual' })
  check('21 GET /connect/ -> 308 to /connect, headers present', res.status === 308 && res.headers.get('location') === '/connect' && res.headers.get('x-content-type-options') === 'nosniff', { status: res.status })
  res = await call('GET', '/connect/connect.js')
  check('22 GET /connect/connect.js -> 200 javascript with the headers', res.status === 200 && (res.headers.get('content-type') ?? '').includes('javascript') && (res.headers.get('content-security-policy') ?? '') !== '', { status: res.status, type: res.headers.get('content-type') })
  res = await call('GET', '/connect/nope')
  check('23 GET /connect/nope -> 404 with the headers', res.status === 404 && (res.headers.get('content-security-policy') ?? '') !== '', { status: res.status })
  res = await call('GET', '/connect.js')
  check('24 GET /connect.js (an asset name outside /connect) -> not served', res.status !== 200 && !(res.headers.get('content-type') ?? '').includes('javascript'), { status: res.status })
  res = await call('GET', '/.well-known/vibase')
  body = await json(res)
  check('25 GET /.well-known/vibase -> auth.publishable_key is null (no key configured)', res.status === 200 && body.auth?.publishable_key === null, body.auth)

  // 26-29: the MCP endpoint ([[API106]] D4): hand-written JSON-RPC in the bundle, no SDK, no nodejs_compat (this Miniflare sets none).
  const mcp = async (method: string, params?: unknown, id = 1) => {
    const r = await call('POST', '/mcp', { token: key, headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) } })
    return { status: r.status, body: await json(r) }
  }
  let m = await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
  check('26 POST /mcp initialize -> 2025-11-25, instructions, serverInfo', m.status === 200 && m.body.result?.protocolVersion === '2025-11-25' && typeof m.body.result?.instructions === 'string' && m.body.result?.serverInfo?.name === 'vibase', m)
  m = await mcp('tools/list')
  const toolNames: string[] = (m.body.result?.tools ?? []).map((t: { name: string }) => t.name)
  check('27 POST /mcp tools/list -> the agent\'s tools, no human-only tool, no binary tool', m.status === 200 && toolNames.includes('tasks_create') && toolNames.includes('schema_get') && !toolNames.some((n) => n.startsWith('agents_')) && !toolNames.includes('files_content'), toolNames.length)
  const mcpEventsBefore = await count('events')
  m = await mcp('tools/call', { name: 'tasks_create', arguments: { title: 'from mcp' } })
  const mcpActor = await rows("select actor_id from events where type = 'task.created' order by rowid desc limit 1")
  check('28 POST /mcp tools/call tasks_create -> a task, one event attributed to the key\'s agent', m.status === 200 && m.body.result?.isError === undefined && m.body.result?.structuredContent?.title === 'from mcp' && (await count('events')) === mcpEventsBefore + 1 && mcpActor[0]?.actor_id === boot.agentId, m)
  // 30-32: MCP OAuth discovery ([[API115]]): the path-specific document, the `mcp` field and the preflight, in workerd.
  res = await call('GET', '/.well-known/oauth-protected-resource/mcp')
  body = await json(res)
  check('30 GET /.well-known/oauth-protected-resource/mcp -> 200, resource <origin>/mcp, no human-only scope', res.status === 200 && body.resource === `${String(base).replace(/\/$/, '')}/mcp` && Array.isArray(body.scopes_supported) && !body.scopes_supported.includes('agents:write') && body.scopes_supported.includes('contacts:write'), body)
  res = await call('GET', '/.well-known/vibase')
  body = await json(res)
  check('31 GET /.well-known/vibase -> mcp is <origin>/mcp', res.status === 200 && body.mcp === `${String(base).replace(/\/$/, '')}/mcp`, body.mcp)
  res = await call('OPTIONS', '/.well-known/oauth-protected-resource/mcp')
  check('32 OPTIONS on the MCP document -> 204 with the preflight headers', res.status === 204 && res.headers.get('access-control-allow-origin') === '*' && res.headers.get('access-control-allow-methods') === 'GET, HEAD' && res.headers.get('access-control-max-age') === '600', { status: res.status })
  res = await call('POST', '/mcp', { headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })
  check('33 POST /mcp without a credential -> 401 with the /mcp challenge', res.status === 401 && (res.headers.get('www-authenticate') ?? '').includes('oauth-protected-resource/mcp", scope="'), res.headers.get('www-authenticate'))
  check('29 the bundle contains no MCP SDK', !readFileSync(bundle, 'utf8').includes('@modelcontextprotocol'), undefined)

  // 34-37: the content pipeline in workerd ([[CORE69]] D15). A second, smoke-only bundle (never deployed, not imported by worker.ts)
  // runs `captureMessages` with FakeChannel, the real `workerdStreams()` and Miniflare's own D1 and R2.
  const pipelineBundle = join(workerDir, 'pipeline.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('./smoke-pipeline-entry.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    target: 'es2022',
    outfile: pipelineBundle,
    logLevel: 'warning',
  })
  console.log(`pipeline bundle ${statSync(pipelineBundle).size} bytes`)
  pipelineMf = new Miniflare({
    modules: true,
    scriptPath: pipelineBundle,
    modulesRoot: workerDir,
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: `pipeline-${crypto.randomUUID()}` },
    d1Persist: false,
    r2Buckets: ['BODIES'],
    bindings: { AUTH_ORG_ID: 'org_pipeline' },
  })
  const pipelineBase = await pipelineMf.ready
  const pd1 = (await pipelineMf.getD1Database('DB')) as unknown as D1Like
  await applyMigrations(pd1)
  await bootstrapD1(pd1, { organizationName: 'Pipeline', agentName: 'pipeline-bot', authOrgId: 'org_pipeline' })
  const pBodies = (await pipelineMf.getR2Bucket('BODIES')) as unknown as { list(o: { prefix: string }): Promise<{ objects: Array<{ key: string; size: number }> }> }
  const pRows = async (sqlText: string) => ((await pd1.prepare(sqlText).all()).results ?? []) as Array<Record<string, unknown>>
  const run = await fetch(new URL('/run', pipelineBase))
  const pipelineResult = (await run.json()) as { captured?: number; attachments?: { stored: number; failed: number; skipped: number }; error?: string }
  const pOrg = String((await pRows('select organization_id as o from deployment'))[0]!.o)

  const attachmentBytes = bytesOf(ATTACHMENT_BYTES)
  const wantSha = createHash('sha256').update(attachmentBytes).digest('hex')
  const fileRows = await pRows('select sha256, size_bytes, storage_key from files')
  const blob = fileRows[0] ? await pBodies.list({ prefix: `${fileRows[0].storage_key}/` }) : { objects: [] }
  check(
    '34 the pipeline in workerd: an attachment is stored, its hash (crypto.DigestStream) and size match its bytes',
    run.status === 200 && pipelineResult.captured === 3 && fileRows.length === 1 && fileRows[0]!.sha256 === wantSha && Number(fileRows[0]!.size_bytes) === ATTACHMENT_BYTES && blob.objects.length === 1 && blob.objects[0]!.size === ATTACHMENT_BYTES,
    { status: run.status, pipelineResult, fileRows, blob },
  )

  const bigPrefix = await messageContentPrefix(pOrg, 'email', '<smoke-big@fake.test>')
  const big = await pBodies.list({ prefix: `${bigPrefix}/v1/original` })
  check('35 the pipeline in workerd: an original of unknown size over 5 MiB is stored whole (R2 multipart)', big.objects.length === 1 && big.objects[0]!.size === ORIGINAL_BYTES, big)

  const mismatchRows = await pRows("select a.fetch_status as s, a.fetch_error as e, a.file_id as f from message_attachments a join messages m on m.id = a.message_id where m.external_id = '<smoke-mismatch@fake.test>'")
  const blobs = await pBodies.list({ prefix: `orgs/${pOrg}/files/` })
  check(
    '36 the pipeline in workerd: a length mismatch is recorded failed with no object left (FixedLengthStream)',
    mismatchRows.length === 1 && mismatchRows[0]!.s === 'failed' && mismatchRows[0]!.e === 'length_mismatch' && mismatchRows[0]!.f === null && blobs.objects.length === 1 && pipelineResult.attachments?.failed === 1,
    { mismatchRows, blobs: blobs.objects.map((o) => o.key), pipelineResult },
  )

  const counts = Object.fromEntries(await Promise.all(['messages', 'interactions', 'message_sources', 'threads'].map(async (t) => [t, Number((await pRows(`select count(*) as n from ${t}`))[0]!.n)] as const)))
  const eventTypes = (await pRows("select type from events where type in ('message.created', 'interaction.created', 'thread.created', 'file.created')")).map((r) => String(r.type))
  check(
    '37 the pipeline in workerd: rows and events exist',
    counts.messages === 3 && counts.interactions === 3 && counts.message_sources === 3 && counts.threads === 3 && eventTypes.filter((t) => t === 'message.created').length === 3 && eventTypes.includes('file.created'),
    { counts, eventTypes },
  )

  // 38-42: the Gmail channel in workerd ([[CHN5]] cycle 1): `GmailChannel` over `FakeGmail`'s wire form through the same pipeline.
  // The fake serves JSON with one base64url member in uneven chunks, so the real streaming decoder, `hast-util-from-html` and
  // `hast-util-to-mdast` all run in workerd, and the original is stored from a stream of unknown length.
  const gmailRun = await fetch(new URL('/gmail', pipelineBase))
  const gmailResult = (await gmailRun.json()) as { captured?: number; attachments?: { stored: number; failed: number; skipped: number }; error?: string }
  const gAttBytes = bytesOf(ATTACHMENT_BYTES, GMAIL_ATTACHMENT_SEED)
  const gFiles = await pRows("select f.sha256 as sha256, f.size_bytes as size_bytes, f.storage_key as k from files f join message_attachments a on a.file_id = f.id join messages m on m.id = a.message_id where m.external_id = 'g-att@acme.test'")
  const gBlob = gFiles[0] ? await pBodies.list({ prefix: `${gFiles[0].k}/` }) : { objects: [] }
  check(
    '38 the Gmail path in workerd: an attachment decoded from the wire form is stored with matching hash and size',
    gmailRun.status === 200 && gmailResult.captured === 4 && gFiles.length === 1 && gFiles[0]!.sha256 === createHash('sha256').update(gAttBytes).digest('hex') && Number(gFiles[0]!.size_bytes) === ATTACHMENT_BYTES && gBlob.objects.length === 1 && gBlob.objects[0]!.size === ATTACHMENT_BYTES,
    { status: gmailRun.status, gmailResult, gFiles, gBlob },
  )
  const gBigPrefix = await messageContentPrefix(pOrg, 'email', 'g-big@acme.test')
  const gBig = await pBodies.list({ prefix: `${gBigPrefix}/v1/original` })
  check('39 the Gmail path in workerd: an original over 5 MiB, decoded from the wire form, is stored whole by multipart', gBig.objects.length === 1 && gBig.objects[0]!.size === ORIGINAL_BYTES, gBig)
  const gMismatch = await pRows("select a.fetch_status as s, a.fetch_error as e, a.file_id as f from message_attachments a join messages m on m.id = a.message_id where m.external_id = 'g-mismatch@acme.test'")
  check('40 the Gmail path in workerd: a declared size that is not the decoded size is a failed link with no file', gMismatch.length === 1 && gMismatch[0]!.s === 'failed' && gMismatch[0]!.e === 'length_mismatch' && gMismatch[0]!.f === null && gmailResult.attachments?.failed === 1, { gMismatch, gmailResult })
  const tableObject = await (pBodies as unknown as { get(k: string): Promise<{ text(): Promise<string> } | null> }).get(messageBodyKey(await messageContentPrefix(pOrg, 'email', 'g-table@acme.test'), 1))
  const tableMd = tableObject ? await tableObject.text() : ''
  check('41 the Gmail path in workerd: the HTML part becomes markdown with its table (hast-util-to-mdast)', tableMd.includes('| Item    | Qty |') && tableMd.includes('# Quarterly') && !tableMd.includes('PLAIN VERSION'), tableMd)
  const gRows = await pRows("select count(*) as n from message_sources where provider_message_id like 'g-%'")
  const gEvents = await pRows("select count(*) as n from events where type = 'message.created'")
  check('42 the Gmail path in workerd: four messages with sources and events beside the FakeChannel ones', Number(gRows[0]!.n) === 4 && Number(gEvents[0]!.n) === 7, { gRows, gEvents })
} catch (err) {
  failures++
  console.log(`FAIL smoke aborted -> ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await mf?.dispose()
  await pipelineMf?.dispose()
  rmSync(workerDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks ok')
