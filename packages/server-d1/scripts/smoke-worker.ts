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
import { hashApiKey, messageContentPrefix, messageBodyKey, fileBlobKey, openToken, type R2BucketLike } from '@vibase/api'
import { FAKE_GOOGLE_ORIGIN, FakeGoogle } from '@vibase/api/test/google'
import { FakeGmail } from '@vibase/api/test/gmail'
import { gmailFixture } from '@vibase/api/test/gmail-fixtures'
import { bytesOf } from '@vibase/api/test/channels'
import { ATTACHMENT_BYTES, GMAIL_ATTACHMENT_SEED, ORIGINAL_BYTES } from './smoke-pipeline-sizes.js'
import { applyControlMigrations, applyMigrations, createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb, writeControlMarker, type D1Like } from '@vibase/storage-d1'
import {
  API_URL,
  SECRET_KEY,
  clerkUser,
  fakeClerkFetch,
  mintClerkToken,
  orgClaim,
  testIssuer,
} from '@vibase/api/test/clerk'
import { bootstrapD1 } from '../src/bootstrap-d1.js'
import { buildConnect } from './build-connect.js'
import { buildUi } from './build-ui.js'
import { UI_RUN_WORKER_FIRST } from '../src/ui-serving.js'
import { ALLOWED_NODE_MODULES, BUNDLE_SIZE_CEILING, nodeImportProblems, nodeImportsOf } from './node-imports.js'

let failures = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

/** Every line Miniflare and the Worker's console print (workerd's stdout and stderr), kept for the secret-absence check. */
const logLines: string[] = []
const pipelineLogLines: string[] = []
const capture = (stream: NodeJS.ReadableStream, into: string[] = logLines) => {
  let rest = ''
  stream.on('data', (chunk: Buffer) => {
    const parts = (rest + chunk.toString()).split('\n')
    rest = parts.pop() ?? ''
    into.push(...parts)
  })
  stream.on('end', () => rest && into.push(rest))
}

const workerDir = mkdtempSync(join(tmpdir(), 'vb-d1-worker-'))
const bundle = join(workerDir, 'worker.mjs')
const assetsDir = join(workerDir, 'assets')
const entry = fileURLToPath(new URL('../src/worker.ts', import.meta.url))

const issuer = await testIssuer()
const profiles = new Map([
  ['user_owner', clerkUser({ id: 'user_owner', email: 'owner@smoke.test', role: 'owner' })],
  ['user_new', clerkUser({ id: 'user_new', email: 'new@smoke.test' })],
])
const clerk = fakeClerkFetch(profiles)
// CHN140: the connect flow runs against a fake Google. The Worker calls Google's real hostnames; the outbound service below answers
// exactly these by rewriting them onto the fake's origin, and still refuses every other host.
const GOOGLE_HOSTS = new Set(['https://oauth2.googleapis.com', 'https://www.googleapis.com', 'https://gmail.googleapis.com'])
const CREDENTIALS_KEY_BYTES = new Uint8Array(32).fill(11)
const google = await FakeGoogle.create({ clientId: 'smoke-client.apps.test', clientSecret: 'smoke-client-secret' })
const hostsSeen = new Set<string>()
// [[API220]]: the webhook sender's receiver. The outbound service answers it 200 and keeps what it was sent, so W6 sees a real signed POST leave the bundle.
const HOOK_ORIGIN = 'https://hook.smoke.test'
const hookPosts: { headers: Record<string, string>; body: string }[] = []
// [[CHN141]]: the mailbox the connect flow connects holds three messages, served over HTTP at Gmail's real hostname through the outbound service.
const SYNC_MAILBOX_MESSAGES = ['w-1', 'w-2', 'w-3']
const syncGmail = new FakeGmail(
  SYNC_MAILBOX_MESSAGES.map((id, i) =>
    gmailFixture('plain', (m) => ({ ...m, id, threadId: `t-${id}`, headers: m.headers.map(([k, v]): [string, string] => [k, k === 'Message-ID' ? `<${id}@smoke.test>` : v]), internalDate: Date.now() - 3_600_000 - i * 1000 })),
  ),
  { chunk: 2048, profile: { emailAddress: 'mailbox@smoke.test', historyId: '777' } },
)
// [[CHN155]]: Gmail push in workerd. The JWKS is Google's real URL, answered by the outbound service with the fake Google's key (no variable redirects it, D87, D93);
// a count of its fetches lets a check prove a refused request made none. `gate`, while set, holds the sync run's Gmail calls so a burst of pushes meets a held lease.
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
let jwksFetches = 0
let gate: Promise<void> | null = null
let releaseGate: () => void = () => {}
const PUSH_TOPIC = 'projects/smoke-p/topics/gmail.watch'
const PUSH_SUBSCRIPTION = 'projects/smoke-p/subscriptions/gmail.push'
const PUSH_SERVICE_ACCOUNT = 'push@smoke-p.iam.gserviceaccount.com'
const PUSH_BASE_URL = 'https://push.test'
let mf: Miniflare | undefined
let pipelineMf: Miniflare | undefined
const authMfs: Miniflare[] = []

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    target: 'es2022',
    outfile: bundle,
    // `nodejs_compat` ([[CORE243]] D2): `node:` imports stay external for workerd to resolve, as wrangler does.
    external: ['cloudflare:workers', 'node:*'],
    logLevel: 'warning',
  })
  const bundleBytes = statSync(bundle).size
  console.log(`bundle ${bundleBytes} bytes (${bundle})`)
  // [[CORE243]] D2: the bundle's `node:` imports are an explicit list and its size has a ceiling.
  const nodeProblems = nodeImportProblems(readFileSync(bundle, 'utf8'), bundleBytes)
  check(`0 the bundle imports only the allowed node: modules (${nodeImportsOf(readFileSync(bundle, 'utf8')).join(', ') || 'none'}; allowed ${ALLOWED_NODE_MODULES.join(', ')}) and is under ${BUNDLE_SIZE_CEILING} bytes (${bundleBytes})`, nodeProblems.length === 0, nodeProblems)
  // [[UI30]] D2, D3: a fresh build of the connect page, mounted as Workers Static Assets the way wrangler maps run_worker_first.
  await buildConnect(assetsDir)
  // [[UI246]] D2: and the auth pages' bundle beside it, routed to the Worker first by the same list `wrangler.jsonc` carries.
  await buildUi(assetsDir)

  mf = new Miniflare({
    // Explicit module list: Better Auth's `import(variable)` defeats Miniflare's own module scan (wrangler and workerd accept it).
    modules: [{ type: 'ESModule', path: bundle, contents: readFileSync(bundle, 'utf8') }],
    modulesRoot: workerDir,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: `smoke-${crypto.randomUUID()}` },
    d1Persist: false,
    r2Buckets: ['BODIES'],
    // [[CHN141]] D34: the real MailSyncWorkflow, exported by the real bundle, run by Miniflare's Workflows engine.
    workflows: { MAIL_SYNC: { name: 'vb-smoke-mail-sync', className: 'MailSyncWorkflow' } },
    assets: { directory: assetsDir, binding: 'ASSETS', routerConfig: { has_user_worker: true, static_routing: { user_worker: ['/connect', '/connect/*', ...UI_RUN_WORKER_FIRST] } } },
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
      GOOGLE_CLIENT_ID: google.clientId,
      GOOGLE_CLIENT_SECRET: google.clientSecret,
      OAUTH_STATE_SECRET: 'smoke-state-secret',
      CREDENTIALS_KEY: Buffer.from(CREDENTIALS_KEY_BYTES).toString('base64'),
      // [[CHN153]]: the Google recorder is on, as a deployed var would set it, a day ahead of the real clock workerd runs on.
      GOOGLE_RECORDING_UNTIL: new Date(Date.now() + 86_400_000).toISOString(),
      // [[CHN155]] D87: push on (Gmail, the MAIL_SYNC workflow binding and these four). PUBLIC_BASE_URL is also the connect flow's redirect base.
      GMAIL_TOPIC_NAME: PUSH_TOPIC,
      GMAIL_PUSH_SUBSCRIPTION: PUSH_SUBSCRIPTION,
      GMAIL_PUSH_SERVICE_ACCOUNT: PUSH_SERVICE_ACCOUNT,
      PUBLIC_BASE_URL: PUSH_BASE_URL,
    },
    outboundService: async (req: Request) => {
      const url = new URL(req.url)
      hostsSeen.add(url.origin)
      if (`${url.origin}${url.pathname}` === JWKS_URL) jwksFetches++
      if (url.origin === 'https://gmail.googleapis.com' && /^\/gmail\/v1\/users\/me\/(history|messages)/.test(url.pathname)) {
        if (gate) await gate
        return syncGmail.handle(req, (t) => google.isAccessToken(t))
      }
      if (GOOGLE_HOSTS.has(url.origin)) {
        const rewritten = new URL(`${url.pathname}${url.search}`, FAKE_GOOGLE_ORIGIN)
        // The token endpoint lives at /token on the fake and at oauth2.googleapis.com/token for real: the path already matches.
        return google.fetch(rewritten.toString(), { method: req.method, headers: req.headers, body: req.method === 'POST' ? await req.text() : undefined })
      }
      if (url.origin === HOOK_ORIGIN) {
        hookPosts.push({ headers: Object.fromEntries(req.headers), body: await req.text() })
        return new Response(null, { status: 200 })
      }
      if (url.origin !== API_URL) return new Response('blocked by the smoke: not the fake Clerk or Google host', { status: 502 })
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
  for (const [path, title] of [['/api/v1/openapi.json', 'Vibase records API'], ['/meta/v1/openapi.json', 'Vibase meta API']] as const) {
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


  // 43-44: the Gmail connect flow in workerd ([[CHN140]] D1, D4, D9, D57): authorize, Google's consent (faked), the callback. Web Crypto
  // AES-GCM and HMAC, `jose` against the fake's JWKS, and the one D1 unit all run in the real bundle. Nothing watches, nothing syncs (D55).
  // Before check 16 on purpose: the network guard must see the Google hosts the flow reached.
  const ownerNow = await mintClerkToken(issuer, { sub: 'user_owner', extra: { vibase_role: 'owner' } })
  res = await call('POST', '/meta/v1/connections/authorize', { token: ownerNow, body: { provider: 'google' } })
  body = await json(res)
  const authorizeUrl = String(body.authorize_url ?? '')
  check('43 POST /meta/v1/connections/authorize as an owner -> 200, a Google URL with PUBLIC_BASE_URL as the redirect_uri base and an S256 challenge', res.status === 200 && authorizeUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth?') && new URL(authorizeUrl).searchParams.get('redirect_uri') === `${PUSH_BASE_URL}/oauth/google/callback` && new URL(authorizeUrl).searchParams.get('code_challenge_method') === 'S256', { status: res.status, body })
  const eventsBeforeConnect = await count('events')
  const callbackUrl = new URL(await google.consent(authorizeUrl.replace('https://accounts.google.com', FAKE_GOOGLE_ORIGIN), { sub: 'smoke-sub', email: 'Mailbox@Smoke.test', historyId: '777', sendAs: [{ sendAsEmail: 'mailbox@smoke.test', isPrimary: true }, { sendAsEmail: 'alias@smoke.test', verificationStatus: 'accepted' }] }))
  res = await call('GET', `${callbackUrl.pathname}${callbackUrl.search}`)
  const connectedPage = await res.text()
  const conn = (await rows('select * from channel_connections'))[0]
  const cred = (await rows('select * from channel_credentials'))[0]
  const refresh = google.refreshTokens.at(-1) ?? ''
  const opened = cred ? await openToken(CREDENTIALS_KEY_BYTES, String(cred.refresh_token_ciphertext)).catch(() => '') : ''
  const ownValues = (await rows('select value from identities where own = 1 order by value')).map((r) => String(r.value))
  const newEvents = (await rows('select type, actor_id from events order by seq')).slice(eventsBeforeConnect)
  const cursor = (await rows('select * from mail_sync_cursors'))[0]
  check(
    '44 the callback in workerd -> 200 built-in page; one connection owned by the user, an encrypted credential that opens to the refresh token, the cursor, own identities and the events; and the watch row (push is on), registered for INBOX and SENT',
    res.status === 200 &&
      connectedPage.includes('You can close this tab') &&
      (await count('channel_connections')) === 1 &&
      conn?.account_id === 'smoke-sub' &&
      conn?.status === 'active' &&
      refresh !== '' &&
      String(cred?.refresh_token_ciphertext ?? '') !== '' &&
      !String(cred?.refresh_token_ciphertext).includes(refresh) &&
      opened === refresh &&
      cursor?.history_id === '777' &&
      (await count('mail_sync_state')) === 1 &&
      (await count('gmail_watches')) === 1 &&
      google.watchRequests.length === 1 &&
      JSON.stringify(google.watchRequests[0]?.body) === JSON.stringify({ topicName: PUSH_TOPIC, labelIds: ['INBOX', 'SENT'], labelFilterBehavior: 'include' }) &&
      (await rows('select mailbox from gmail_watches'))[0]?.mailbox === 'mailbox@smoke.test' &&
      ownValues.join() === 'alias@smoke.test,mailbox@smoke.test' &&
      newEvents.filter((x) => x.type === 'connection.created').length === 1 &&
      newEvents.filter((x) => x.type === 'identity.created').length === 2 &&
      newEvents.every((x) => x.actor_id === conn?.owner_id),
    { status: res.status, connectedPage: connectedPage.slice(0, 300), conn, newEvents },
  )
  const connectLogs = logLines.join('\n')
  check('44a no Worker log line holds the refresh token, an access token or the client secret', !connectLogs.includes(refresh) && google.accessTokens.every((t) => !connectLogs.includes(t)) && !connectLogs.includes(google.clientSecret), undefined)

  // W1-W5: the sync engine in workerd ([[CHN141]]): the callback above requested a sync, so the REAL `MailSyncWorkflow` (exported by this very bundle) ran in
  // Miniflare's Workflows engine against Google faked at the outbound fetch. A backfill, the cursor, the lease and the owner as actor are read back from D1.
  const connId = String(conn?.id ?? '')
  const waitFor = async (what: string, ok: () => Promise<boolean>) => {
    for (let i = 0; i < 150; i++) {
      if (await ok()) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    console.log(`timed out waiting for ${what}`)
    return false
  }
  const stateOf = async () => (await rows('select last_success_at, lease_until, run_id, sync_requested_at from mail_sync_state where connection_id = ?', connId))[0]
  const done = await waitFor('the first sync run', async () => (await stateOf())?.last_success_at != null && (await stateOf())?.lease_until == null)
  const firstSuccess = String((await stateOf())?.last_success_at ?? '')
  const sourced = (await rows('select provider_message_id as p, created_by as c from message_sources where connection_id = ? order by provider_message_id', connId))
  const syncCursor = (await rows('select history_id, page_token, last_synced_at from mail_sync_cursors where connection_id = ?', connId))[0]
  const msgEvents = (await rows("select actor_id from events where type = 'message.created'"))
  check(
    'W1 the real MailSyncWorkflow ran from the real bundle in workerd: the callback\'s sync request backfilled the mailbox, released the lease and stamped last_success_at',
    done && sourced.map((r) => r.p).join() === SYNC_MAILBOX_MESSAGES.join() && sourced.every((r) => r.c === conn?.owner_id) && syncCursor?.page_token === null && typeof syncCursor?.last_synced_at === 'string' && msgEvents.length === 3 && msgEvents.every((x) => x.actor_id === conn?.owner_id) && (await stateOf())?.run_id == null,
    { done, sourced, syncCursor, state: await stateOf() },
  )
  res = await call('POST', `/meta/v1/connections/${connId}/sync`, { token: ownerNow })
  body = await json(res)
  const secondDone = await waitFor('the second sync run', async () => String((await stateOf())?.last_success_at ?? '') > firstSuccess && (await stateOf())?.lease_until == null)
  const fullFetches = syncGmail.calls.filter((c) => c.op === 'full').length
  check('W2 POST /meta/v1/connections/{id}/sync in workerd -> 202 requested_at, a second Workflow run finished, and nothing was captured or fetched twice', res.status === 202 && typeof body.requested_at === 'string' && secondDone && (await count('message_sources')) === 3 && fullFetches === 3, { status: res.status, body, secondDone, fullFetches })
  await ((await mf.getWorker()) as unknown as { scheduled(o: { cron: string }): Promise<unknown> }).scheduled({ cron: '0 0 1 1 *' })
  await new Promise((r) => setTimeout(r, 200))
  check('W3 an unknown cron expression reaches the Worker\'s scheduled handler in workerd and is logged, not thrown', logLines.some((l) => l.includes('unknown cron') && l.includes('0 0 1 1 *')), undefined)
  await ((await mf.getWorker()) as unknown as { scheduled(o: { cron: string }): Promise<unknown> }).scheduled({ cron: '*/15 * * * *' })
  await new Promise((r) => setTimeout(r, 200))
  check('W4 the */15 cron in workerd runs without an error line (the connection is fresh, so it requests nothing)', !logLines.some((l) => /\[cron\].*(error|failed)/i.test(l)) && (await count('message_sources')) === 3, undefined)
  // W6, W7 ([[AGT8]] D54, D52, [[API219]] D6): the per-minute cron runs the rail tick, then webhook dispatch, on the real bundle in workerd; the bundle holds no test kit.
  // A subscription of the smoke agent and one task event made after it must produce exactly one pending delivery row on that tick (API220: the sender then delivers it to the fake receiver in the same tick).
  const hook = await json(await call('POST', '/meta/v1/webhooks', { token: key, body: { url: `${HOOK_ORIGIN}/smoke-hook`, event_types: ['task.created'] } }))
  const hooked = await json(await call('POST', '/api/v1/tasks', { token: key, body: { title: 'webhook dispatch task' } }))
  check('W6a a webhook subscription and a task made after it, before the per-minute cron (no delivery row yet)', typeof hook.id === 'string' && typeof hooked.id === 'string' && (await count('webhook_deliveries')) === 0, { hook: hook.id, task: hooked.id })
  await ((await mf.getWorker()) as unknown as { scheduled(o: { cron: string }): Promise<unknown> }).scheduled({ cron: '* * * * *' })
  await new Promise((r) => setTimeout(r, 200))
  check('W6 the * * * * * cron in workerd runs the rail tick then webhook dispatch on the real bundle: both lines are logged in that order, with no error line, nothing expired or attempted, and one delivered row for the task event, sent after dispatch', (() => {
    const cron = logLines.filter((l) => l.includes('[cron] * * * * *'))
    const railAt = cron.findIndex((l) => l.includes('rail expired 0 request(s), attempted 0 execution(s)'))
    const hooksAt = cron.findIndex((l) => l.includes('webhooks dispatched 1 event(s) for 1 subscription(s)'))
    const sentAt = cron.findIndex((l) => l.includes('webhooks sent 1, failed 0, dead 0, cancelled 0, deferred 0'))
    return railAt >= 0 && hooksAt > railAt && sentAt > hooksAt && !logLines.some((l) => /\[cron\] \* \* \* \* \*: (failed:|webhook (dispatch|send) failed)/i.test(l)) // the sender's own line says "failed 0": only the error lines count
  })(), logLines.filter((l) => l.includes('[cron]')).slice(-4))
  const delivery = await rows('select subscription_id, event_type, status, attempts from webhook_deliveries')
  check('W6b the delivery row: the subscription, task.created, delivered, attempts 1', delivery.length === 1 && delivery[0]!.subscription_id === hook.id && delivery[0]!.event_type === 'task.created' && delivery[0]!.status === 'delivered' && Number(delivery[0]!.attempts) === 1, delivery)
  check('W6c the receiver got one POST with the five headers and the event record as the body, and the Worker log holds no signature', hookPosts.length === 1 && ['content-type', 'user-agent', 'webhook-id', 'webhook-signature', 'webhook-timestamp'].every((h) => typeof hookPosts[0]!.headers[h] === 'string') && JSON.parse(hookPosts[0]!.body).type === 'task.created' && !logLines.some((l) => l.includes(hookPosts[0]!.headers['webhook-signature']!)), hookPosts.map((p) => Object.keys(p.headers)))
  const bundleText = readFileSync(bundle, 'utf8')
  check('W7 the Worker bundle holds the rail but none of the test kit (no test operation, no fake transport)', bundleText.includes('action_executions.finish') && ['test.enqueue', 'test-enqueue', 'FakeTransport', 'registerTestOperations'].every((m) => !bundleText.includes(m)), undefined)
  const syncLogs = logLines.join('\n')
  check('W5 no Worker log line across the Workflow runs holds a refresh token, an access token or the client secret', google.refreshTokens.every((t) => !syncLogs.includes(t)) && google.accessTokens.length > 0 && google.accessTokens.every((t) => !syncLogs.includes(t)) && !syncLogs.includes(google.clientSecret), { accessTokens: google.accessTokens.length })

  // R1-R4: the recorder in workerd ([[CHN153]] D78, D79): a deployed binding turned it on; the connect callback and the Workflow's steps recorded through R2.
  const recBucket = (await mf.getR2Bucket('BODIES')) as unknown as { list(o: { prefix: string }): Promise<{ objects: Array<{ key: string }> }>; get(k: string): Promise<{ text(): Promise<string> } | null> }
  const recKeys = (await recBucket.list({ prefix: '_recordings/' })).objects.map((o) => o.key).filter((k) => !k.endsWith('index.json'))
  const recKinds = recKeys.map((k) => /\/\d{3}-([a-z_]+)-\d+-/.exec(k)?.[1] ?? '?')
  const recText = (await Promise.all(recKeys.map(async (k) => (await (await recBucket.get(k))?.text()) ?? ''))).join('\n')
  const recPrefixes = new Set(recKeys.map((k) => k.split('/')[1]))
  check('R1 the recorder in workerd: objects appear under _recordings/ for the connect callback (token exchange, profile, send-as, watch) and for the sync Workflow (token refresh, lists, message full)', ['token_exchange', 'profile', 'send_as', 'watch', 'token_refresh', 'messages_list', 'message_full'].every((k) => recKinds.includes(k)), recKinds)
  check('R2 the callback and the Workflow instance record under their own run prefixes, and only Google kinds are recorded (no Clerk call)', recPrefixes.size >= 2 && recKinds.every((k) => ['token_exchange', 'token_refresh', 'profile', 'send_as', 'watch', 'history_list', 'messages_list', 'message_full', 'message_raw', 'attachment_get'].includes(k)), [...recPrefixes])
  check('R3 no recording holds the refresh token, an access token, the client secret or a message body (deny by default, in the bundle)', recText.length > 0 && google.refreshTokens.every((t) => !recText.includes(t)) && google.accessTokens.every((t) => !recText.includes(t)) && !recText.includes(google.clientSecret) && !recText.includes('Hello Owner'), { bytes: recText.length })
  check('R4 the index lists every recording, and the Workflow still finished with the recorder on (W1 above)', JSON.parse((await (await recBucket.get('_recordings/index.json'))?.text()) ?? '{"objects":[]}').objects.length === recKeys.length, { recKeys: recKeys.length })

  // PU1-PU8: Gmail push in workerd ([[CHN155]], [[CHN5]] D87, D88): the real bundle, `jose` verifying RS256 against Google's keys served through the outbound service, the
  // route through the real composition, and `MAIL_SYNC.create` (one instance per burst, counted by the Worker's own log line). The connection is the one the callback
  // connected above, with the watch row it registered.
  const lineCount = (needle: string) => logLines.filter((l) => l.includes(needle)).length
  const instancesCreated = () => lineCount('[gmail-push] sync requested')
  const pushToken = async (over: { aud?: string; email?: string } = {}) => {
    const iat = Math.floor(Date.now() / 1000)
    return google.signToken({ iss: 'https://accounts.google.com', aud: over.aud ?? `${PUSH_BASE_URL}/gmail/push`, sub: '100000000000000000001', email: over.email ?? PUSH_SERVICE_ACCOUNT, email_verified: true, iat, exp: iat + 3600 })
  }
  const pushBody = (emailAddress: string) => JSON.stringify({ message: { data: btoa(JSON.stringify({ emailAddress, historyId: '1' })).replace(/\+/g, '-').replace(/\//g, '_'), messageId: '1' }, subscription: PUSH_SUBSCRIPTION })
  const pushNow = (token: string | null, emailAddress = 'Mailbox@Smoke.test') => call('POST', '/gmail/push', { ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), raw: pushBody(emailAddress) })
  const requestedAt = async () => String((await stateOf())?.sync_requested_at ?? '')
  const flat = async () => JSON.stringify([await rows('select * from mail_sync_state'), await rows('select * from mail_sync_cursors'), await rows('select * from gmail_watches'), await count('events')])

  gate = new Promise<void>((r) => (releaseGate = r))
  const jwks0 = jwksFetches
  const inst0 = instancesCreated()
  const req0 = await requestedAt()
  res = await pushNow(null)
  check('PU1 POST /gmail/push with no Authorization header in workerd -> 401, no JWKS fetch, no instance, no write', res.status === 401 && jwksFetches === jwks0 && instancesCreated() === inst0 && (await requestedAt()) === req0, { status: res.status, jwksFetches: jwksFetches - jwks0 })
  res = await pushNow(await pushToken())
  const afterFirst = await requestedAt()
  check('PU2 a locally signed push for Mailbox@Smoke.test (mixed case) -> 204, jose verified it against the JWKS fetched once, sync_requested_at advanced, one MAIL_SYNC instance created', res.status === 204 && jwksFetches === jwks0 + 1 && afterFirst > req0 && instancesCreated() === inst0 + 1, { status: res.status, jwks: jwksFetches - jwks0, req0, afterFirst, instances: instancesCreated() - inst0 })
  const statuses: number[] = []
  for (let i = 0; i < 10; i++) statuses.push((await pushNow(await pushToken())).status)
  check('PU3 the same push ten more times -> all 204, still one instance, and sync_requested_at advanced each time (the held lease or the recent request covers them)', statuses.every((x) => x === 204) && instancesCreated() === inst0 + 1 && (await requestedAt()) > afterFirst, { statuses, instances: instancesCreated() - inst0 })
  const flatBefore = await flat()
  const instBefore = instancesCreated()
  res = await pushNow(await pushToken({ aud: `${PUSH_BASE_URL}/other` }))
  check('PU4 a token with the wrong aud -> 401, nothing written, no instance', res.status === 401 && (await flat()) === flatBefore && instancesCreated() === instBefore, { status: res.status })
  res = await pushNow(await pushToken({ email: 'someone-else@smoke-p.iam.gserviceaccount.com' }))
  check('PU4b a token for another service account -> 401', res.status === 401 && (await flat()) === flatBefore, { status: res.status })
  res = await pushNow(await pushToken(), 'nobody@example.test')
  check('PU5 a valid token for a mailbox nobody watches -> 204, no write, no instance', res.status === 204 && (await flat()) === flatBefore && instancesCreated() === instBefore, { status: res.status })
  releaseGate()
  gate = null
  const settled = await waitFor('the pushed sync run', async () => (await stateOf())?.lease_until == null && String((await stateOf())?.last_success_at ?? '') > afterFirst)
  check('PU6 the held run finishes once released: the lease is gone and last_success_at is after the first push', settled, await stateOf())
  const pushLogs = logLines.join('\n')
  check('PU7 no Worker log line holds the signed token, the service account, the topic or the mailbox address across the push steps', !pushLogs.includes(PUSH_SERVICE_ACCOUNT) && !pushLogs.includes(PUSH_TOPIC) && !pushLogs.toLowerCase().includes('mailbox@smoke.test'), undefined)

  // PU8: stop on delete in workerd, recorded under its own run ([[CHN5]] D91, D92).
  const stops0 = google.stopRequests.length
  res = await call('DELETE', `/meta/v1/connections/${connId}`, { token: ownerNow })
  const recKeysAfter = (await recBucket.list({ prefix: '_recordings/' })).objects.map((o) => o.key)
  const stopKeys = recKeysAfter.filter((k) => /\/\d{3}-stop-\d+-/.test(k))
  check('PU8 DELETE /meta/v1/connections/{id} in workerd -> 204, one users.stop with a refreshed token, the watch row gone, the stop recorded under its own run prefix', res.status === 204 && google.stopRequests.length === stops0 + 1 && google.isAccessToken(google.stopRequests.at(-1)?.token ?? '') && (await count('gmail_watches')) === 0 && stopKeys.length === 1 && new Set(recKeysAfter.filter((k) => !k.endsWith('index.json')).map((k) => k.split('/')[1])).size >= 3, { status: res.status, stops: google.stopRequests.length - stops0, stopKeys })

  // 16: the network guard
  // CHN140: the Google hosts are answered by the fake too (check 43); nothing else may be reached.
  check('16 the Worker reached only the fake Clerk host, the faked Google hosts and the fake webhook receiver', hostsSeen.size > 0 && [...hostsSeen].every((h) => h === API_URL || GOOGLE_HOSTS.has(h) || h === HOOK_ORIGIN), [...hostsSeen])

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
  // [[UI246]] D1: on clerk the auth pages and their bundle are no route at all, with the real assets binding in front of the Worker (the built files exist: only the provider decides).
  for (const path of ['/sign-in', '/invite', '/reset-password', '/ui/app.js']) {
    res = await call('GET', path)
    check(`24b GET ${path} on clerk -> 404 not_found (the auth pages exist only on better-auth)`, res.status === 404 && (await json(res)).error?.code === 'not_found', { status: res.status })
  }
  res = await call('GET', '/.well-known/vibase')
  body = await json(res)
  check('25 GET /.well-known/vibase -> auth.publishable_key is null (no key configured)', res.status === 200 && body.auth?.publishable_key === null, body.auth)

  // [[CORE243]] D1: with AUTH_PROVIDER=clerk the built-in provider's /auth is no route, in the real bundle under nodejs_compat.
  res = await call('GET', '/auth/ok')
  body = await json(res)
  check('25a GET /auth/ok with AUTH_PROVIDER=clerk -> 404 not_found in the app envelope', res.status === 404 && body.error?.code === 'not_found', { status: res.status, body })

  // [[CORE259]] D1, D3, D6, D7: the real bundle with AUTH_PROVIDER=better-auth in workerd, with and without the control-plane binding. Each is its own Miniflare (the main one is Clerk).
  const betterAuth = async (withControl: boolean) => {
    const auth = new Miniflare({
      modules: [{ type: 'ESModule', path: bundle, contents: readFileSync(bundle, 'utf8') }],
      modulesRoot: workerDir,
      compatibilityDate: '2026-07-30',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: `smoke-auth-crm-${crypto.randomUUID()}`, ...(withControl ? { CONTROL_DB: `smoke-auth-control-${crypto.randomUUID()}` } : {}) },
      d1Persist: false,
      bindings: { AUTH_PROVIDER: 'better-auth', AUTH_SECRET: 'smoke-auth-secret-0123456789-abcdefghij-klmnop', PUBLIC_BASE_URL: 'http://localhost:8787' },
      outboundService: () => new Response('blocked by the smoke', { status: 502 }),
    })
    authMfs.push(auth)
    const url = await auth.ready
    const crm = (await auth.getD1Database('DB')) as unknown as D1Like
    await applyMigrations(crm)
    const boot = await bootstrapD1(crm, { organizationName: 'Auth smoke', agentName: 'auth-bot', authProvider: 'better-auth', email: 'o@smoke.test', authOrgId: 'org_auth_smoke' })
    let control: D1Like | undefined
    if (withControl) {
      control = (await auth.getD1Database('CONTROL_DB')) as unknown as D1Like
      await applyControlMigrations(control)
      await writeControlMarker(openControlDb(control), boot.organizationId)
    }
    const get = (path: string) => fetch(new URL(path, url), { headers: { origin: 'http://localhost:8787', 'cf-connecting-ip': '203.0.113.9' } })
    return { crm, control, get }
  }
  {
    const without = await betterAuth(false)
    res = await without.get('/auth/ok')
    check('25b better-auth without CONTROL_DB -> 500 internal on /auth, /health stays 200', res.status === 500 && (await without.get('/health')).status === 200, { status: res.status })
    const withControl = await betterAuth(true)
    res = await withControl.get('/auth/ok')
    check('25c better-auth with a migrated, paired CONTROL_DB -> /auth/ok 200 in workerd', res.status === 200, { status: res.status })
    res = await withControl.get('/auth/jwks')
    const keyRows = Number(((await withControl.control!.prepare('select count(*) as n from auth_jwks').first()) as { n: number }).n)
    // OPS260's 0019 dropped the CRM copy of the table: absent is the strongest form of empty.
    const crmRows = Number(((await withControl.crm.prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'auth_jwks'").first()) as { n: number }).n)
    check('25d better-auth /auth/jwks writes the signing key into CONTROL_DB and leaves the CRM auth_jwks empty', res.status === 200 && keyRows > 0 && crmRows === 0, { status: res.status, keyRows, crmRows })
  }

  // 26-29: the MCP endpoint ([[API106]] D4): hand-written JSON-RPC in the bundle, no SDK.
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
  const mcpActor = await rows("select actor_id from events where type = 'task.created' order by seq desc limit 1")
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
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: `pipeline-${crypto.randomUUID()}` },
    d1Persist: false,
    r2Buckets: ['BODIES'],
    handleRuntimeStdio: (stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream) => {
      capture(stdout, pipelineLogLines)
      capture(stderr, pipelineLogLines)
    },
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

  // P1-P4: the capture pages in workerd ([[CHN149]]): a backfill, then a history page, through the smoke pipeline bundle (which holds the page code;
  // `src/worker.ts` tree-shakes it). A fake token endpoint, Web Crypto sealing and opening of the refresh token, Miniflare's D1 and R2.
  const pagesRun = await fetch(new URL('/gmail-pages', pipelineBase))
  const pages = (await pagesRun.json()) as { run?: { outcome: string; captured: number; scans: string[]; pages: number }; connectionId?: string; hosts?: string[]; secrets?: string[]; error?: string }
  const pageSources = await pRows("select provider_message_id as p, created_by as c from message_sources where provider_message_id like 'p-%'")
  const pageCursor = ((await pd1.prepare('select history_id, page_token, last_synced_at from mail_sync_cursors where connection_id = ?').bind(pages.connectionId ?? '').first()) as Record<string, unknown> | null)
  check(
    'P1 the capture pages in workerd: a backfill then a history page capture the mail through the pipeline',
    pagesRun.status === 200 && pages.run?.outcome === 'complete' && pages.run.captured === 3 && pages.run.scans.join() === 'backfill' && pageSources.map((r) => r.p).sort().join() === 'p-in,p-new,p-sent',
    { status: pagesRun.status, pages, pageSources },
  )
  check('P2 the capture pages in workerd: the cursor holds the history page\'s id and the last-synced stamp', pageCursor?.history_id === '1002' && pageCursor?.page_token === null && typeof pageCursor.last_synced_at === 'string', pageCursor)
  const credRows = await pRows('select refresh_token_ciphertext as c from channel_credentials')
  check('P3 the capture pages in workerd: only the faked token host was reached, and the stored credential is not the refresh token', JSON.stringify(pages.hosts) === JSON.stringify(['https://oauth2.googleapis.com']) && credRows.length >= 1 && credRows.every((r) => !(pages.secrets ?? []).some((s) => String(r.c).includes(s))), { hosts: pages.hosts })
  const pageLogText = pipelineLogLines.join('\n')
  check('P4 the capture pages in workerd: no token or client secret in any runtime log line', (pages.secrets ?? []).length > 2 && (pages.secrets ?? []).every((s) => !pageLogText.includes(s)), { lines: pipelineLogLines.length })
} catch (err) {
  failures++
  console.log(`FAIL smoke aborted -> ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await mf?.dispose()
  await pipelineMf?.dispose()
  for (const a of authMfs) await a.dispose()
  rmSync(workerDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks ok')
