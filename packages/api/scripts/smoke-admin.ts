// End-to-end smoke for [[CORE3]] administration (the directory sync by webhook, members, agents, API keys), served by the
// prepared operations since [[CORE40]]. Needs no Clerk account: it generates an RS256 key pair, runs a fake Clerk Backend API
// locally and serves the real app over HTTP against DATABASE_URL.
//
//   SMOKE_EXPECT_DATABASE=<db> pnpm -C packages/api smoke:admin
//
// It refuses to run unless `current_database()` equals SMOKE_EXPECT_DATABASE: an exported DATABASE_URL overrides --env-file,
// so printing the database name is not enough (CORE36 retro, CORE40 P14).
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { SignJWT, exportSPKI, generateKeyPair } from 'jose'
import { sql } from 'kysely'
import { createDb, withServiceRole } from '@vault/db'
import { createAuthAdapter } from '../src/auth/adapter.js'
import { createVaultRegistry } from '../src/operations.js'
import { postgresBinding } from '@vault/storage-postgres'
import { createApp } from '../src/rest/app.js'

const ISSUER = 'https://smoke.clerk.test'
const rand = randomBytes(4).toString('hex')
const owner = { sub: `user_smoke_${rand}_owner`, email: `owner-${rand}@example.test` }
const member = { sub: `user_smoke_${rand}_member`, email: `member-${rand}@example.test` }
const profiles = new Map<string, unknown>([
  [owner.sub, userJson(owner.sub, owner.email)],
  // Never signs in until the webhook has copied them.
  [member.sub, userJson(member.sub, member.email)],
])
// The fake Clerk's organisation and its (mutable) memberships.
const orgExt = `org_smoke_${rand}`
const organizations = new Map<string, unknown>([[orgExt, { object: 'organization', id: orgExt, name: `Smoke ${rand}` }]])
const clerkMembers: { role: string; public_user_data: { user_id: string } }[] = [{ role: 'org:admin', public_user_data: { user_id: owner.sub } }]

function userJson(id: string, email: string, verified = true) {
  return {
    id,
    first_name: 'Smoke',
    last_name: 'Test',
    primary_email_address_id: 'idn_1',
    email_addresses: [{ id: 'idn_1', email_address: email, verification: { status: verified ? 'verified' : 'unverified' } }],
  }
}

const listen = (server: Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))

const fakeClerk = createServer((req, res) => {
  const url = new URL(req.url ?? '', 'http://fake')
  const respond = (body: unknown | undefined) => {
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? { errors: [{ code: 'resource_not_found' }] }))
  }
  const list = /^\/v1\/organizations\/([^/]+)\/memberships$/.exec(url.pathname)
  if (list) {
    if (decodeURIComponent(list[1]!) !== orgExt) return respond(undefined)
    const limit = Number(url.searchParams.get('limit') ?? 10)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    return respond({ data: clerkMembers.slice(offset, offset + limit), total_count: clerkMembers.length })
  }
  const org = /^\/v1\/organizations\/([^/]+)$/.exec(url.pathname)
  if (org) return respond(organizations.get(decodeURIComponent(org[1]!)))
  const m = /^\/v1\/users\/([^/]+)$/.exec(url.pathname)
  respond(m ? profiles.get(decodeURIComponent(m[1]!)) : undefined)
})
const clerkPort = await listen(fakeClerk)

const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
const pem = await exportSPKI(publicKey)

// The app listens on a port chosen up front so the authorised party can name it.
const probe = createServer()
const appPort = await listen(probe)
await new Promise((r) => probe.close(r))
const origin = `http://localhost:${appPort}`

const webhookSecret = 'whsec_' + randomBytes(24).toString('base64')
const adapter = createAuthAdapter({
  AUTH_PROVIDER: 'clerk',
  CLERK_JWT_KEY: pem,
  CLERK_ISSUER: ISSUER,
  CLERK_AUTHORIZED_PARTIES: origin,
  CLERK_SECRET_KEY: 'sk_smoke',
  CLERK_WEBHOOK_SECRET: webhookSecret,
  CLERK_API_URL: `http://127.0.0.1:${clerkPort}`,
})!

const db = createDb(process.env.DATABASE_URL ?? 'postgresql://vault_app@localhost/vault_dev', { max: 4 })
const dbName = (await sql<{ current_database: string }>`SELECT current_database()`.execute(db)).rows[0]!.current_database
console.log(`database ${dbName}`)
const expectedDb = process.env.SMOKE_EXPECT_DATABASE
if (!expectedDb || dbName !== expectedDb) {
  console.error(`refusing to run: connected to "${dbName}", expected SMOKE_EXPECT_DATABASE="${expectedDb ?? ''}"`)
  await db.destroy()
  process.exit(1)
}

const storage = postgresBinding(db)
const app = createApp({ db: () => db, authAdapter: adapter, corsOrigins: [origin], storage: () => storage })
const server = serve({ fetch: app.fetch, port: appPort, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${appPort}`
const declared = createVaultRegistry().declaredScopes()

const mint = (sub: string, o: { azp?: string; exp?: number; rol?: string } = {}) => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ azp: o.azp ?? origin, sid: 'sess_smoke', v: 2, ...(o.rol ? { o: { id: orgExt, rol: o.rol, slg: 'smoke' } } : {}) })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setSubject(sub)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(o.exp ?? now + 60)
    .sign(privateKey)
}

let failures = 0
async function check(
  name: string,
  req: { path: string; method?: string; scheme?: string; token?: string; org?: string; body?: unknown },
  expectStatus: number,
  verify?: (json: any, res: Response) => string | undefined,
): Promise<any> {
  const headers: Record<string, string> = {}
  if (req.token) headers.authorization = `${req.scheme ?? 'Bearer'} ${req.token}`
  if (req.org) headers['x-organization-id'] = req.org
  const res = await fetch(base + req.path, {
    method: req.method ?? 'GET',
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : undefined
  const problem = res.status !== expectStatus ? `expected ${expectStatus}` : verify?.(json, res)
  if (problem) failures++
  console.log(`${problem ? 'FAIL' : 'ok  '} ${name} -> ${res.status}${json?.error ? ` ${json.error.code}` : ''}${problem ? ` (${problem})` : ''}`)
  return json
}

/** A Svix-signed delivery to /webhooks/clerk. */
async function deliver(type: string, data: unknown, opts: { secret?: string; id?: string } = {}): Promise<Response> {
  const body = JSON.stringify({ data, object: 'event', type, timestamp: Date.now() })
  const id = opts.id ?? `msg_${randomBytes(8).toString('hex')}`
  const ts = String(Math.floor(Date.now() / 1000))
  const key = Buffer.from((opts.secret ?? webhookSecret).replace(/^whsec_/, ''), 'base64')
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  return fetch(`${base}/webhooks/clerk`, {
    method: 'POST',
    headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}`, 'content-type': 'application/json' },
    body,
  })
}
async function webhook(name: string, type: string, data: unknown, expectStatus = 200, opts: { secret?: string; id?: string } = {}) {
  const res = await deliver(type, data, opts)
  const ok = res.status === expectStatus
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} -> ${res.status}`)
}
const membershipData = () => ({ organization: { id: orgExt } })

/** Directory events (organization.*, membership.*) of one organisation straight from the database (service role): types in order and their actors. */
async function events(organizationId: string) {
  return withServiceRole(db, async (trx) => {
    const rows = await trx.selectFrom('events').select(['type', 'actor_id']).where('organization_id', '=', organizationId)
      .where((eb) => eb.or([eb('type', 'like', 'organization.%'), eb('type', 'like', 'membership.%')]))
      .execute()
    const system = await trx.selectFrom('principals').select('id').where('kind', '=', 'system').executeTakeFirst()
    return { types: rows.map((r) => r.type).sort(), allSystem: rows.every((r) => r.actor_id === system?.id) }
  })
}
const eq = (a: unknown, b: unknown, what: string) => (JSON.stringify(a) === JSON.stringify(b) ? undefined : `${what}: got ${JSON.stringify(a)}`)

try {
  const tokO = await mint(owner.sub, { rol: 'org:admin' })
  const tokM = await mint(member.sub, { rol: 'org:member' })

  await check('GET /openapi.json', { path: '/openapi.json' }, 200, (j) => {
    const have = new Set(Object.values(j.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId)))
    const missing = createVaultRegistry().operations().map((o) => o.name).filter((n) => !have.has(n))
    return missing.length ? `missing ${missing.join(', ')}` : undefined
  })
  const me = await check('GET /me (owner, first sight, claim repairs the copy)', { path: '/me', token: tokO }, 200, (j) =>
    eq(j.active_organization?.role, 'owner', 'role'),
  )
  const orgId = me.active_organization.id as string

  await webhook('bad signature', 'organizationMembership.created', membershipData(), 401, { secret: 'whsec_' + randomBytes(24).toString('base64') })
  clerkMembers.push({ role: 'org:member', public_user_data: { user_id: member.sub } })
  const created = `msg_${randomBytes(8).toString('hex')}`
  await webhook('organizationMembership.created (member who never signed in)', 'organizationMembership.created', membershipData(), 200, { id: created })
  await check('GET /memberships (owner)', { path: '/memberships', token: tokO }, 200, (j) => eq(j.data.length, 2, 'count'))
  await check('GET /users (owner)', { path: '/users', token: tokO }, 200, (j) => eq(j.data.length, 2, 'count'))
  const users = await check('GET /users (owner, to find the member)', { path: '/users', token: tokO }, 200)
  const memberUser = users.data.find((u: { email: string }) => u.email === member.email)
  await check('GET /users/{id} (member who never signed in)', { path: `/users/${memberUser?.id}`, token: tokO }, 200, (j) => eq(j.email, member.email, 'email'))
  await check('GET /users/nope', { path: '/users/nope', token: tokO }, 404, (j) => eq(j.error.code, 'not_found', 'code'))
  await check('GET /memberships (member, first sign-in)', { path: '/memberships', token: tokM }, 200, (j) => eq(j.data.length, 2, 'count'))
  const before = await events(orgId)
  await webhook('replayed delivery', 'organizationMembership.created', membershipData(), 200, { id: created })
  const after = await events(orgId)
  const replayed = eq(after.types, before.types, 'event types after a replay')
  if (replayed) failures++
  console.log(`${replayed ? 'FAIL' : 'ok  '} replay adds no events${replayed ? ` (${replayed})` : ''}`)

  await check('POST /agents (member)', { path: '/agents', method: 'POST', token: tokM, body: { name: 'Bot', scopes: [] } }, 403, (j) => eq(j.error.code, 'insufficient_scope', 'code'))
  await check('POST /agents (human-only scope)', { path: '/agents', method: 'POST', token: tokO, body: { name: 'Bot', scopes: ['members:read'] } }, 400, (j) => eq(j.error.code, 'scope_not_grantable', 'code'))
  await check('POST /agents (unknown scope)', { path: '/agents', method: 'POST', token: tokO, body: { name: 'Bot', scopes: ['nope:read'] } }, 400, (j) => eq(j.error.code, 'unknown_scope', 'code'))
  const agent = await check('POST /agents', { path: '/agents', method: 'POST', token: tokO, body: { name: `Bot ${rand}`, scopes: ['tasks:read', 'tasks:write'] } }, 201)
  const made = await check('POST /api-keys', { path: '/api-keys', method: 'POST', token: tokO, body: { agent_id: agent.id } }, 201, (j) => (typeof j.key === 'string' && j.key.startsWith('vk_') ? undefined : 'no key'))
  await check('GET /tasks (agent key)', { path: '/tasks', token: made.key }, 200)
  await check('GET /agents (agent key)', { path: '/agents', token: made.key }, 403, (j) => eq(j.error.code, 'insufficient_scope', 'code'))
  const keyBody = await fetch(`${base}/api-keys?agent_id=${agent.id}`, { headers: { authorization: `Bearer ${tokO}` } })
  const keyText = await keyBody.text()
  const leaked = keyBody.status !== 200 || /"key"|key_hash/.test(keyText)
  if (leaked) failures++
  console.log(`${leaked ? 'FAIL' : 'ok  '} GET /api-keys?agent_id= -> ${keyBody.status} (no key or key_hash in the body)`)

  await check('PATCH /agents/{id} (disable)', { path: `/agents/${agent.id}`, method: 'PATCH', token: tokO, body: { disabled: true } }, 200, (j) => (j.disabled_at ? undefined : 'disabled_at unset'))
  await check('GET /tasks (agent key, disabled)', { path: '/tasks', token: made.key }, 401)
  await check('PATCH /agents/{id} (enable)', { path: `/agents/${agent.id}`, method: 'PATCH', token: tokO, body: { disabled: false } }, 200)
  await check('GET /tasks (agent key, enabled)', { path: '/tasks', token: made.key }, 200)
  const revoked = await check('POST /api-keys/{id}/revoke', { path: `/api-keys/${made.id}/revoke`, method: 'POST', token: tokO }, 200, (j) => (j.revoked_at ? undefined : 'revoked_at unset'))
  const stamped = eq(revoked.updated_at, revoked.revoked_at, 'updated_at moves with revoked_at')
  if (stamped) failures++
  console.log(`${stamped ? 'FAIL' : 'ok  '} revoke stamps updated_at with revoked_at${stamped ? ` (${stamped})` : ''}`)
  await check('GET /tasks (agent key, revoked)', { path: '/tasks', token: made.key }, 401)
  await check('POST /api-keys/{id}/revoke (again)', { path: `/api-keys/${made.id}/revoke`, method: 'POST', token: tokO }, 200, (j) => eq(j.revoked_at, revoked.revoked_at, 'revoked_at'))

  clerkMembers[1]!.role = 'org:admin'
  await webhook('organizationMembership.updated (member becomes admin)', 'organizationMembership.updated', membershipData())
  await check('GET /memberships?role=owner', { path: '/memberships?role=owner', token: tokO }, 200, (j) => eq(j.data.length, 2, 'owners'))
  clerkMembers.pop()
  await webhook('organizationMembership.deleted (member removed)', 'organizationMembership.deleted', membershipData())
  await check('GET /memberships (one left)', { path: '/memberships', token: tokO }, 200, (j) => eq(j.data.length, 1, 'count'))
  await check('GET /tasks (removed member, token without the organisation)', { path: '/tasks', token: await mint(member.sub) }, 403, (j) =>
    eq(j.error.code, 'organization_required', 'code'),
  )

  const final = await events(orgId)
  const expected = ['membership.created', 'membership.created', 'membership.deleted', 'membership.updated', 'organization.created']
  const problem = eq(final.types, expected, 'event types') ?? (final.allSystem ? undefined : 'a directory event is not attributed to the system principal')
  if (problem) failures++
  console.log(`${problem ? 'FAIL' : 'ok  '} directory events: ${final.types.join(', ')}${problem ? ` (${problem})` : ''}`)
  console.log(`organization_id: ${orgId}`)
} finally {
  server.close()
  fakeClerk.close()
  await db.destroy()
}
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks ok')
