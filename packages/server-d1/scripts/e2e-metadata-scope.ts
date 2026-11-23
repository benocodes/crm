// API516 (#516, API514 cycle 3): `messages:read_metadata` live, end to end on the built-in provider. The vault Worker runs in Miniflare on `AUTH_PROVIDER=better-auth` with migrated CRM and
// control databases; a Better Auth signing key is seeded in `auth_jwks` (the private half stays here and mints the tokens the Worker's adapter then verifies, 516.9's premise); the owner is a
// Better Auth user and an owner member. Two Gmail fixtures (`plain`, `attachment`) are recorded IN-PROCESS through the vault's capture pipeline (`captureMessages` over FakeGmail, the Worker's
// own D1 and R2): the MAIL_SYNC Workflow leg of `e2e:webhook-example` (red on main, #520) is not used. Agents hold the stored scopes an older release would have stored; nothing leaves the machine.
// pnpm -C packages/server-d1 e2e:metadata-scope
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { execute, uuidv7 } from '@vibase/storage'
import { d1Binding, MIGRATIONS, openControlDb, type D1Like } from '@vibase/storage-d1'
import {
  MIGRATIONS_DIR,
  applyControlMigrations,
  splitStatements,
  createMigrationTracker,
  recordMigrations,
} from '@vibase/storage-d1/test'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { ScopeSet, createVibaseRegistry, defaultGrantScopes, grantableScopes } from '@vibase/api'
import { BA_BASE, baIssuer, mintBaToken } from '@vibase/api/test/better-auth'
import { FakeGmail } from '@vibase/api/test/gmail'
import { gmailFixture } from '@vibase/api/test/gmail-fixtures'
import { connectOperation } from '../../api/src/connections/connect.js'
import { captureMessages } from '../../api/src/messaging/pipeline.js'
import { GmailChannel } from '../../api/src/channels/gmail/channel.js'
import { r2ObjectStore } from '../../api/src/objects/store.js'
import { nodeStreams } from '../../api/src/test/streams.js'
import { bootstrapD1 } from '../src/bootstrap-d1.js'
import { mintControlKey } from './e2e-keys.js'

const dir = mkdtempSync(join(tmpdir(), 'vb-metadata-scope-e2e-'))
const vibaseBundle = join(dir, 'vibase.mjs')
const AUTH_SECRET = 'e2e-metadata-scope-auth-secret-0123456789abcdef'
const MAILBOX = 'owner@vibase.test'
const OWNER_USER = 'ba-user-owner'
const CLIENT_D = 'client-d'
const logs: string[] = []
const issuer = await baIssuer('e2e-key-1')
let mf: Miniflare | undefined
// The signed deliveries each agent's endpoint was sent, as the vault's sender made them.
const deliveries: Record<'a' | 'b' | 'c', Array<{ body: string }>> = { a: [], b: [], c: [] }

try {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/worker.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    target: 'es2022',
    outfile: vibaseBundle,
    external: ['cloudflare:workers', 'cloudflare:workflows', 'node:*'],
    logLevel: 'warning',
  })
  console.log(`bundle: vibase ${statSync(vibaseBundle).size} bytes`)
  mf = new Miniflare({
    handleRuntimeStdio: (stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream) => {
      for (const stream of [stdout, stderr]) stream.on('data', (b: Buffer) => logs.push(b.toString()))
    },
    d1Persist: join(dir, 'd1'),
    r2Persist: join(dir, 'r2'),
    workflowsPersist: join(dir, 'workflows'),
    workers: [
      {
        name: 'vb',
        modules: [{ type: 'ESModule', path: vibaseBundle, contents: readFileSync(vibaseBundle, 'utf8') }],
        modulesRoot: dir,
        compatibilityDate: '2026-07-30',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'metadata-scope-e2e', CONTROL_DB: 'metadata-scope-e2e-control' },
        r2Buckets: ['BODIES'],
        workflows: { MAIL_SYNC: { name: 'metadata-scope-e2e-sync', className: 'MailSyncWorkflow' } },
        bindings: {
          AUTH_PROVIDER: 'better-auth',
          AUTH_SECRET,
          PUBLIC_BASE_URL: BA_BASE,
          CORS_ALLOWED_ORIGINS: '',
          GOOGLE_CLIENT_ID: 'meta-e2e-client',
          GOOGLE_CLIENT_SECRET: 'meta-e2e-secret',
          OAUTH_STATE_SECRET: 'meta-e2e-state',
          CREDENTIALS_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
          WEBHOOK_ALLOW_INSECURE_URLS: 'true',
        },
        outboundService: async (req: Request) => {
          const u = new URL(req.url)
          if (u.hostname === 'receiver.test') {
            const which = u.pathname.slice(1) as 'a' | 'b' | 'c'
            deliveries[which].push({ body: await req.text() })
            return new Response(null, { status: 200 })
          }
          throw new Error(`blocked E2E outbound host ${u.hostname}`)
        },
      },
    ],
  })
  await mf.ready
  const d1 = (await mf.getD1Database('DB')) as unknown as D1Like
  const control = (await mf.getD1Database('CONTROL_DB')) as unknown as D1Like
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
  for (const f of migrations)
    await d1.batch(splitStatements(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).map((s) => d1.prepare(s)))
  await applyControlMigrations(control)
  const boot = await bootstrapD1(
    d1,
    {
      organizationName: 'Metadata Scope E2E',
      authProvider: 'better-auth',
      authOrgId: 'metadata-scope-e2e',
      publicBaseUrl: BA_BASE,
    },
    { control: openControlDb(control) },
  )
  await createMigrationTracker(d1)
  await recordMigrations(
    d1,
    MIGRATIONS.map((m) => m.name).concat(migrations.filter((f) => !MIGRATIONS.some((m) => m.name === f))),
  )
  const org = boot.organizationId
  const at = new Date().toISOString()
  const rows = async (s: string, ...binds: unknown[]) =>
    (
      await d1
        .prepare(s)
        .bind(...binds)
        .all()
    ).results as any[]

  // Seeding (516's decision 516.10, "how the E2E seeds Better Auth"): a signing key in auth_jwks (public half; the adapter reads `id`, `alg`, `public_key`), the owner as an `auth_users` row
  // (the profile first sight of a delegated agent reads) and as a vault user with an owner membership linked to it, exactly what an accepted invitation leaves behind.
  await control
    .prepare('insert into auth_jwks (id, public_key, private_key, created_at, alg, crv) values (?, ?, ?, ?, ?, ?)')
    .bind(issuer.kid, issuer.publicJwk, 'not-used-by-the-adapter', at, 'EdDSA', 'Ed25519')
    .run()
  await control
    .prepare(
      'insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
    )
    .bind(OWNER_USER, 'Owner', 'owner@vibase.test', 1, at, at)
    .run()
  const owner = uuidv7()
  await seedPrincipal(d1, {
    id: owner,
    kind: 'user',
    email: 'owner@vibase.test',
    authProvider: 'better-auth',
    authSubject: OWNER_USER,
    emailVerified: true,
  })
  await seedMembership(d1, { organizationId: org, userId: owner, role: 'owner' })

  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await mf!.dispatchFetch(BA_BASE + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
  }
  const mcp = async (token: string, name: string) => {
    const r = await call(token, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    })
    return r.body.result as { isError?: boolean; content: Array<{ text: string }> }
  }
  const ownerToken = await mintBaToken(issuer, { sub: OWNER_USER, kind: 'session' })
  // PREMISE (516.9): the adapter accepts a token signed with the key seeded in auth_jwks.
  const me = await call(ownerToken, 'GET', '/meta/v1/me')
  assert.equal(
    me.status,
    200,
    `premise: the Worker verifies a token minted with the seeded auth_jwks key: ${JSON.stringify(me.body)}`,
  )
  assert.equal(me.body.principal.id, owner)
  const forged = await mintBaToken(await baIssuer('e2e-key-1'), { sub: OWNER_USER, kind: 'session' })
  assert.equal(
    (await call(forged, 'GET', '/meta/v1/me')).status,
    401,
    'a token signed by another key under the same kid is refused',
  )

  // A Gmail connection (no network: capture runs in this process).
  const tenant = { kind: 'tenant' as const, actorId: owner, organizationId: org }
  const env = {
    actor: { id: owner, kind: 'user' as const },
    organizationId: org,
    scopes: ScopeSet.parse([]),
    now: new Date(),
    newId: uuidv7,
    randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  }
  const binding = d1Binding(d1, { organizationId: org, authProvider: 'better-auth', authOrgId: 'metadata-scope-e2e' })
  const connection = (
    await execute(
      binding,
      tenant,
      connectOperation(env, {
        google_sub: 'meta-e2e-mailbox',
        mailbox: MAILBOX,
        own_addresses: [MAILBOX],
        granted_scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
        ],
        ciphertext: 'not-a-real-ciphertext',
        key_version: 1,
        history_id: '1000',
      }),
    )
  ).value.connection_id as string

  // Agents seeded with the stored scopes an older release would have stored. C is stored with messages:read while its subscription is made (the subscription check needs the read scope) and narrowed to events:read after.
  const declared = createVibaseRegistry().declaredScopes()
  const agents = {
    a: { scopes: ['messages:read_metadata', 'events:read', 'webhooks:read'], key: '', id: uuidv7() },
    b: { scopes: ['messages:read', 'events:read', 'webhooks:read'], key: '', id: uuidv7() },
    c: { scopes: ['messages:read', 'events:read', 'webhooks:read'], key: '', id: uuidv7() },
  }
  const subscriptions: Record<string, string> = {}
  for (const [name, a] of Object.entries(agents)) {
    a.key = 'vk_' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    await seedAgent(d1, { id: a.id, organizationId: org, createdBy: owner, name: `agent-${name}`, scopes: a.scopes })
    await mintControlKey(control, { organizationId: org, agentId: a.id, actorId: owner, key: a.key })
    const created = await call(ownerToken, 'POST', '/meta/v1/webhooks', {
      url: `http://receiver.test/${name}`,
      event_types: ['message.created', 'thread.created'],
      agent_id: a.id,
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    subscriptions[name] = created.body.id
  }
  await d1
    .prepare('update agents set scopes = ? where id = ?')
    .bind(JSON.stringify(['events:read', 'webhooks:read']), agents.c.id)
    .run()
  agents.c.scopes = ['events:read', 'webhooks:read']

  // Record the two fixtures through the vault's capture pipeline, in this process, over the Worker's own D1 and R2.
  // Miniflare's R2 handle wants a known-length stream from a Node caller: buffer the stream, then put the bytes (the Worker's own store streams natively).
  const r2 = r2ObjectStore((await mf.getR2Bucket('BODIES')) as never)
  const bodies = {
    ...r2,
    putStream: async (
      key: string,
      body: ReadableStream<Uint8Array>,
      opts: { size: number | null; contentType?: string },
    ) =>
      r2.put(
        key,
        new Uint8Array(await new Response(body).arrayBuffer()),
        opts.contentType ? { contentType: opts.contentType } : undefined,
      ),
  }
  const gmail = new FakeGmail([gmailFixture('plain'), gmailFixture('attachment')])
  const captured = await captureMessages(
    {
      binding,
      organizationId: org,
      actorId: owner,
      objects: bodies,
      streams: nodeStreams(),
      clock: () => new Date(),
      newId: uuidv7,
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    },
    new GmailChannel(gmail),
    { id: connection },
    ['plain', 'with-attachment'],
  )
  assert.equal(captured.captured, 2, JSON.stringify(captured))
  const withAttachment = (await rows("select id from messages where external_id = 'with-attachment@acme.test'"))[0]!
    .id as string
  const scheduled = async () => {
    await ((await mf!.getWorker('vb')) as unknown as { scheduled(o: { cron: string }): Promise<unknown> }).scheduled({
      cron: '* * * * *',
    })
  }
  await scheduled()

  const CONTENT_KEYS = ['preview', 'attachments']
  const eventsOf = (b: any) => (b.data as any[]).filter((e) => /^(message|thread)\./.test(e.type))
  const sides = (e: any) => [e.before, e.after].filter((x) => x != null)

  // A: messages:read_metadata + events:read.
  const A = agents.a.key
  const aMessages = await call(A, 'GET', '/api/v1/messages')
  assert.equal(aMessages.status, 200, JSON.stringify(aMessages.body))
  assert.equal(aMessages.body.data.length, 2)
  for (const m of aMessages.body.data)
    for (const k of CONTENT_KEYS) assert(!(k in m), `A: ${k} absent from a listed message`)
  const aGet = await call(A, 'GET', `/api/v1/messages/${withAttachment}`)
  assert.equal(aGet.status, 200)
  for (const k of CONTENT_KEYS) assert(!(k in aGet.body), `A: ${k} absent from the attachment message`)
  const aThreads = await call(A, 'GET', '/api/v1/threads')
  assert.equal(aThreads.status, 200)
  assert.equal(aThreads.body.data.length, 2)
  assert(
    aThreads.body.data.every((t: any) => typeof t.subject === 'string' || t.subject === null),
    'A: threads whole',
  )
  const aContent = await call(A, 'GET', `/api/v1/messages/${withAttachment}/content`)
  assert.deepEqual(
    [aContent.status, aContent.body.error.code, aContent.body.error.message],
    [403, 'insufficient_scope', 'requires messages:read'],
  )
  const aEvents = eventsOf((await call(A, 'GET', '/api/v1/events?limit=200')).body)
  assert(
    aEvents.some((e) => e.type === 'message.created') && aEvents.some((e) => e.type === 'thread.created'),
    'A sees message.* and thread.* events',
  )
  for (const side of aEvents.flatMap(sides))
    for (const k of CONTENT_KEYS) assert(!(k in side), `A: ${k} absent from an event image`)
  const aMcp = await mcp(A, 'messages_list')
  assert.notEqual(aMcp.isError, true, JSON.stringify(aMcp))
  for (const m of JSON.parse(aMcp.content[0]!.text).data)
    for (const k of CONTENT_KEYS) assert(!(k in m), `A: ${k} absent over MCP`)
  assert.equal(deliveries.a.length, 4, 'A: two events per message, four deliveries')
  for (const d of deliveries.a)
    for (const side of sides(JSON.parse(d.body)))
      for (const k of CONTENT_KEYS) assert(!(k in side), `A: ${k} absent from a delivery`)

  // B: messages:read, nothing about read_metadata stored: everything whole, as before.
  const B = agents.b.key
  const bMessages = await call(B, 'GET', '/api/v1/messages')
  assert.equal(bMessages.body.data.length, 2)
  for (const m of bMessages.body.data) assert.equal(typeof m.preview, 'string')
  const bGet = await call(B, 'GET', `/api/v1/messages/${withAttachment}`)
  assert.equal(bGet.body.attachments.length, 1)
  assert.equal((await call(B, 'GET', '/api/v1/threads')).status, 200)
  const bContent = await call(B, 'GET', `/api/v1/messages/${withAttachment}/content`)
  assert.equal(bContent.status, 200, JSON.stringify(bContent.body))
  const bEvents = eventsOf((await call(B, 'GET', '/api/v1/events?limit=200')).body)
  assert(
    bEvents.filter((e) => e.type === 'message.created').every((e) => typeof e.after.preview === 'string'),
    'B: events whole',
  )
  const bMcp = await mcp(B, 'messages_list')
  assert.notEqual(bMcp.isError, true)
  assert(
    JSON.parse(bMcp.content[0]!.text).data.every((m: any) => typeof m.preview === 'string'),
    'B: whole over MCP',
  )
  assert.equal(deliveries.b.length, 4)
  assert(
    deliveries.b
      .map((d) => JSON.parse(d.body))
      .filter((e) => e.type === 'message.created')
      .every((e) => typeof e.after.preview === 'string'),
    'B: deliveries whole',
  )
  assert.deepEqual(
    JSON.parse((await rows('select scopes from agents where id = ?', agents.b.id))[0]!.scopes),
    ['messages:read', 'events:read', 'webhooks:read'],
    'B: stored scopes untouched',
  )

  // C: events:read alone.
  const C = agents.c.key
  for (const path of ['/api/v1/messages', '/api/v1/threads']) {
    const r = await call(C, 'GET', path)
    assert.deepEqual(
      [r.status, r.body.error.code, r.body.error.message],
      [403, 'insufficient_scope', 'requires messages:read_metadata'],
      path,
    )
  }
  assert.equal((await call(C, 'GET', `/api/v1/messages/${withAttachment}`)).status, 403)
  assert.equal(
    eventsOf((await call(C, 'GET', '/api/v1/events?limit=200')).body).length,
    0,
    'C sees no message or thread event',
  )
  assert.equal((await mcp(C, 'messages_list')).isError, true)
  assert.equal(deliveries.c.length, 0, 'C: no delivery')
  assert.deepEqual(
    (await call(ownerToken, 'GET', `/meta/v1/webhooks/${subscriptions.c}/deliveries`)).body.data.filter(
      (d: any) => d.status === 'delivered',
    ),
    [],
  )

  // D: a delegated agent of an OAuth client of the owner, whose stored scopes are the pre-cycle grantable set (with messages:read, without read_metadata).
  const preCycle = grantableScopes(declared).filter((s) => s !== 'messages:read_metadata')
  assert(preCycle.includes('messages:read') && !preCycle.includes('messages:read_metadata'))
  const oauth = (scope: string) =>
    mintBaToken(issuer, { kind: 'oauth', sub: OWNER_USER, clientId: CLIENT_D, scope: `openid ${scope}` })
  const first = await call(await oauth('messages:read'), 'GET', '/meta/v1/me')
  assert.equal(first.status, 200, `D first sight: ${JSON.stringify(first.body)}`)
  await d1
    .prepare('update agents set scopes = ? where auth_client_id = ?')
    .bind(JSON.stringify(preCycle), CLIENT_D)
    .run()
  const dToken = await oauth('messages:read_metadata')
  const dMe = await call(dToken, 'GET', '/meta/v1/me')
  assert.equal(dMe.status, 200, JSON.stringify(dMe.body))
  const dScopes: string[] = dMe.body.active_organization?.scopes ?? []
  assert(dScopes.includes('messages:read_metadata'), `D: me lists messages:read_metadata: ${JSON.stringify(dMe.body)}`)
  assert(!dScopes.includes('messages:read'), 'D: me does not list messages:read')
  const dMessages = await call(dToken, 'GET', '/api/v1/messages')
  assert.equal(dMessages.status, 200, JSON.stringify(dMessages.body))
  for (const m of dMessages.body.data) for (const k of CONTENT_KEYS) assert(!(k in m), `D: ${k} absent`)
  assert.deepEqual(
    JSON.parse((await rows('select scopes from agents where auth_client_id = ?', CLIENT_D))[0]!.scopes),
    preCycle,
    'D: stored scopes never rewritten',
  )

  const all = logs.join('')
  for (const a of Object.values(agents)) assert(!all.includes(a.key), 'no log line holds an agent key')
  assert(defaultGrantScopes(declared).includes('messages:read_metadata'))
  console.log(
    'PASS metadata scope E2E: seeded-key token verified; A projected (REST, MCP, feed, deliveries, content refused); B whole; C refused and silent; D delegated token scoped to read_metadata',
  )
} finally {
  if (mf) await mf.dispose()
  rmSync(dir, { recursive: true, force: true })
}
