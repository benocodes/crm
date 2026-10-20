// End-to-end smoke for [[CORE3]] administration (invitations, members, agents, API keys). Needs no Clerk account: it generates an RS256 key pair,
// runs a fake Clerk Backend API locally and serves the real app over HTTP against DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { SignJWT, exportSPKI, generateKeyPair } from 'jose'
import { sql } from 'kysely'
import { createDb } from '@vault/db'
import { createAuthAdapter } from '../src/auth/adapter.js'
import { createVaultRegistry } from '../src/operations.js'
import { createApp } from '../src/rest/app.js'

const ISSUER = 'https://smoke.clerk.test'
const rand = randomBytes(4).toString('hex')
const owner = { sub: `user_smoke_${rand}_owner`, email: `owner-${rand}@example.test` }
const invitee = { sub: `user_smoke_${rand}_invitee`, email: `invitee-${rand}@example.test` }
const stranger = { sub: `user_smoke_${rand}_stranger`, email: `stranger-${rand}@example.test` }
const profiles = new Map<string, unknown>([
  [owner.sub, userJson(owner.sub, owner.email)],
  [invitee.sub, userJson(invitee.sub, invitee.email)],
  // Invited, but their address is not verified: accepting must be refused.
  [stranger.sub, userJson(stranger.sub, stranger.email, false)],
])

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
  const m = /^\/v1\/users\/([^/?]+)$/.exec(req.url ?? '')
  const user = m ? profiles.get(decodeURIComponent(m[1]!)) : undefined
  res.writeHead(user ? 200 : 404, { 'content-type': 'application/json' })
  res.end(JSON.stringify(user ?? { errors: [{ code: 'resource_not_found' }] }))
})
const clerkPort = await listen(fakeClerk)

const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
const pem = await exportSPKI(publicKey)

// The app listens on a port chosen up front so the authorised party can name it.
const probe = createServer()
const appPort = await listen(probe)
await new Promise((r) => probe.close(r))
const origin = `http://localhost:${appPort}`

const adapter = createAuthAdapter({
  AUTH_PROVIDER: 'clerk',
  CLERK_JWT_KEY: pem,
  CLERK_ISSUER: ISSUER,
  CLERK_AUTHORIZED_PARTIES: origin,
  CLERK_SECRET_KEY: 'sk_smoke',
  CLERK_API_URL: `http://127.0.0.1:${clerkPort}`,
})!

const db = createDb(process.env.DATABASE_URL ?? 'postgresql://vault_app@localhost/vault_dev', { max: 4 })
const dbName = (await sql<{ current_database: string }>`SELECT current_database()`.execute(db)).rows[0]!.current_database
console.log(`database ${dbName}`)

const app = createApp({ db: () => db, authAdapter: adapter, corsOrigins: [origin] })
const server = serve({ fetch: app.fetch, port: appPort, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${appPort}`
const declared = createVaultRegistry().declaredScopes()

const mint = (sub: string, o: { azp?: string; exp?: number } = {}) => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ azp: o.azp ?? origin, sid: 'sess_smoke', v: 2 })
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
const eq = (a: unknown, b: unknown, what: string) => (JSON.stringify(a) === JSON.stringify(b) ? undefined : `${what}: got ${JSON.stringify(a)}`)

try {
  const tokO = await mint(owner.sub)
  const tokI = await mint(invitee.sub)
  const tokS = await mint(stranger.sub)

  await check('GET /openapi.json', { path: '/openapi.json' }, 200, (j) => {
    const have = new Set(Object.values(j.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId)))
    const missing = createVaultRegistry().operations().map((o) => o.name).filter((n) => !have.has(n))
    return missing.length ? `missing ${missing.join(', ')}` : undefined
  })
  const me = await check('GET /me (owner, first sight)', { path: '/me', token: tokO }, 200)
  const org = await check('POST /organizations', { path: '/organizations', method: 'POST', token: tokO, body: { name: `Smoke ${rand}` } }, 201)

  const inv1 = await check('POST /invitations (invitee)', { path: '/invitations', method: 'POST', token: tokO, body: { email: invitee.email, role: 'member' } }, 201)
  await check('POST /invitations (again)', { path: '/invitations', method: 'POST', token: tokO, body: { email: invitee.email, role: 'member' } }, 409, (j) => eq(j.error.code, 'invitation_exists', 'code'))
  const inv2 = await check('POST /invitations (stranger)', { path: '/invitations', method: 'POST', token: tokO, body: { email: stranger.email, role: 'member' } }, 201)

  await check('GET /me (invitee sees the invitation)', { path: '/me', token: tokI }, 200, (j) =>
    eq(j.invitations.map((i: any) => [i.id, i.organization_name, i.role]), [[inv1.id, `Smoke ${rand}`, 'member']], 'invitations'),
  )
  const joined = await check('POST /invitations/{id}/accept (invitee)', { path: `/invitations/${inv1.id}/accept`, method: 'POST', token: tokI }, 200, (j) => eq(j.role, 'member', 'role'))
  await check('POST /invitations/{id}/accept (again)', { path: `/invitations/${inv1.id}/accept`, method: 'POST', token: tokI }, 200, (j) => eq(j.id, joined.id, 'membership id'))
  await check('GET /tasks (invitee, no header)', { path: '/tasks', token: tokI }, 200)
  await check('POST /invitations/{id}/accept (stranger, unverified)', { path: `/invitations/${inv2.id}/accept`, method: 'POST', token: tokS }, 403, (j) => eq(j.error.code, 'email_unverified', 'code'))
  await check("POST /invitations/{id}/accept (stranger, someone else's)", { path: `/invitations/${inv1.id}/accept`, method: 'POST', token: tokS }, 404)

  await check('POST /invitations (member)', { path: '/invitations', method: 'POST', token: tokI, body: { email: `x-${rand}@example.test`, role: 'member' } }, 403, (j) => eq(j.error.code, 'insufficient_scope', 'code'))
  const members = await check('GET /memberships (member)', { path: '/memberships', token: tokI }, 200, (j) => eq(j.data.length, 2, 'count'))
  await check('GET /users (member)', { path: '/users', token: tokI }, 200, (j) => eq(j.data.length, 2, 'count'))
  const ownerMembership = members.data.find((m: any) => m.user_id === me.user.id)
  const inviteeMembership = members.data.find((m: any) => m.id === joined.id)
  await check('PATCH /memberships/{id} (last owner demotes self)', { path: `/memberships/${ownerMembership.id}`, method: 'PATCH', token: tokO, body: { role: 'member' } }, 409, (j) => eq(j.error.code, 'last_owner', 'code'))

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
  await check('GET /tasks (agent key, revoked)', { path: '/tasks', token: made.key }, 401)
  await check('POST /api-keys/{id}/revoke (again)', { path: `/api-keys/${made.id}/revoke`, method: 'POST', token: tokO }, 200, (j) => eq(j.revoked_at, revoked.revoked_at, 'revoked_at'))

  await check('PATCH /memberships/{id} (promote invitee)', { path: `/memberships/${inviteeMembership.id}`, method: 'PATCH', token: tokO, body: { role: 'owner' } }, 200, (j) => eq(j.role, 'owner', 'role'))
  await check('PATCH /memberships/{id} (owner demotes self)', { path: `/memberships/${ownerMembership.id}`, method: 'PATCH', token: tokO, body: { role: 'member' } }, 200)
  await check('DELETE /memberships/{id} (invitee removes former owner)', { path: `/memberships/${ownerMembership.id}`, method: 'DELETE', token: tokI }, 204)
  await check('GET /tasks (removed former owner)', { path: '/tasks', token: tokO }, 403, (j) => eq(j.error.code, 'organization_required', 'code'))
  console.log(`organization_id: ${org.id}`)
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
