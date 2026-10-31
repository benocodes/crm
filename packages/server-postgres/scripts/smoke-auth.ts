// End-to-end smoke for [[CORE3]] authentication: sign-in, the organisation claim and its repair, the header
// rule and CORS. Needs no Clerk account: it generates an RS256 key pair, runs a fake Clerk Backend API locally
// and serves the real app over HTTP against DATABASE_URL.
//
// SMOKE_EXPECT_DATABASE is required: the script refuses to run unless current_database() equals it (an exported
// DATABASE_URL overrides --env-file). Example, from the repo root, against a worktree's private test database:
//   SMOKE_EXPECT_DATABASE=vault_test_<worktree> pnpm -C packages/server-postgres smoke:auth
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { SignJWT, exportSPKI, generateKeyPair } from 'jose'
import { sql } from 'kysely'
import { createDb, withOrganization } from '@vault/db'
import { postgresBinding } from '@vault/storage-postgres'
import { createApp, createAuthAdapter, createVaultRegistry } from '@vault/api'

const ISSUER = 'https://smoke.clerk.test'
const rand = randomBytes(4).toString('hex')
const subjectA = `user_smoke_${rand}_a`
const subjectB = `user_smoke_${rand}_b`
const emailA = `smoke-${rand}@example.test`
const profiles = new Map<string, unknown>([
  [subjectA, userJson(subjectA, emailA)],
  // The second subject reuses the first's email: first sight must refuse it.
  [subjectB, userJson(subjectB, emailA)],
])

function userJson(id: string, email: string) {
  return {
    id,
    first_name: 'Smoke',
    last_name: 'Test',
    primary_email_address_id: 'idn_1',
    email_addresses: [{ id: 'idn_1', email_address: email, verification: { status: 'verified' } }],
  }
}

// Organisations the fake Clerk knows; the script mutates this map.
const organizations = new Map<string, unknown>()

const listen = (server: Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))

const fakeClerk = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]!
  const org = /^\/v1\/organizations\/([^/]+)$/.exec(path)
  const m = /^\/v1\/users\/([^/?]+)$/.exec(path)
  const found = org ? organizations.get(decodeURIComponent(org[1]!)) : m ? profiles.get(decodeURIComponent(m[1]!)) : undefined
  res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
  res.end(JSON.stringify(found ?? { errors: [{ code: 'resource_not_found' }] }))
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
  CLERK_WEBHOOK_SECRET: 'whsec_' + randomBytes(24).toString('base64'),
  CLERK_API_URL: `http://127.0.0.1:${clerkPort}`,
})!

const db = createDb(process.env.DATABASE_URL ?? 'postgresql://vault_app@localhost/vault_dev', { max: 4 })
const dbName = (await sql<{ current_database: string }>`SELECT current_database()`.execute(db)).rows[0]!.current_database
console.log(`database ${dbName}`)
// Guard: an already-exported DATABASE_URL overrides --env-file, so the script refuses to run anywhere but the database
// the caller named (the private worktree test database), instead of only printing it.
const expectedDb = process.env.SMOKE_EXPECT_DATABASE
if (!expectedDb || dbName !== expectedDb) {
  console.error(`refusing to run: connected to "${dbName}", expected SMOKE_EXPECT_DATABASE="${expectedDb ?? ''}"`)
  await db.destroy()
  process.exit(1)
}

const storage = postgresBinding(db)
const app = createApp({ authAdapter: adapter, corsOrigins: [origin], storage: () => storage })
const server = serve({ fetch: app.fetch, port: appPort, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${appPort}`
const declared = createVaultRegistry().declaredScopes()

const mint = (sub: string, o: { azp?: string; exp?: number; org?: { id: string; rol: string } } = {}) => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ azp: o.azp ?? origin, sid: 'sess_smoke', v: 2, ...(o.org ? { o: { ...o.org, slg: 'smoke' } } : {}) })
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

const orgExt = `org_smoke_${rand}`
organizations.set(orgExt, { object: 'organization', id: orgExt, name: `Smoke ${rand}` })

try {
  const tokA = await mint(subjectA)
  const tokOrg = await mint(subjectA, { org: { id: orgExt, rol: 'org:admin' } })
  await check('GET /meta/v1/openapi.json', { path: '/meta/v1/openapi.json' }, 200, (j) => {
    const ids = Object.values(j.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId))
    if (!ids.includes('me.get')) return 'me.get missing'
    if (ids.includes('organizations.create')) return 'organizations.create must be gone'
    return Object.keys(j.paths).some((p) => p.includes('webhooks')) ? 'webhook route must not be documented' : undefined
  })
  await check('GET /meta/v1/me (first sight, no claim)', { path: '/meta/v1/me', token: tokA }, 200, (j) =>
    eq(j.memberships, [], 'memberships') ?? eq(j.active_organization, null, 'active_organization') ?? (j.user.email_verified === true ? undefined : 'email_verified'),
  )
  await check('GET /meta/v1/me (lower-case scheme)', { path: '/meta/v1/me', token: tokA, scheme: 'bearer' }, 200)
  await check('GET /api/v1/tasks (no claim)', { path: '/api/v1/tasks', token: tokA }, 403, (j) => eq(j.error.code, 'organization_required', 'code'))
  const me = await check('GET /meta/v1/me (claim for a new organisation: repaired)', { path: '/meta/v1/me', token: tokOrg }, 200, (j) =>
    eq(j.memberships.length, 1, 'memberships') ??
    eq(j.memberships[0]?.role, 'owner', 'role') ??
    eq(j.active_organization?.role, 'owner', 'active role') ??
    eq(j.active_organization?.scopes, declared, 'scopes'),
  )
  const org1 = { id: me.active_organization.id as string }
  const title = `smoke task ${rand}`
  await check('POST /api/v1/tasks (claim)', { path: '/api/v1/tasks', method: 'POST', token: tokOrg, body: { title } }, 201)
  // [[CORE35]]: the task lifecycle through the prepared path on Postgres, over HTTP.
  const created = await check('POST /api/v1/tasks (lifecycle)', { path: '/api/v1/tasks', method: 'POST', token: tokOrg, body: { title: `${title} lifecycle` } }, 201, (j) =>
    eq(j.status, 'open', 'status') ?? eq(j.completed_at, null, 'completed_at'),
  )
  const taskPath = `/api/v1/tasks/${created.id}`
  await check('PATCH /api/v1/tasks/{id} status done', { path: taskPath, method: 'PATCH', token: tokOrg, body: { status: 'done' } }, 200, (j) =>
    eq(j.status, 'done', 'status') ?? (typeof j.completed_at === 'string' ? undefined : `completed_at: got ${JSON.stringify(j.completed_at)}`),
  )
  await check('PATCH /api/v1/tasks/{id} status open', { path: taskPath, method: 'PATCH', token: tokOrg, body: { status: 'open' } }, 200, (j) =>
    eq(j.status, 'open', 'status') ?? eq(j.completed_at, null, 'completed_at'),
  )
  await check('DELETE /api/v1/tasks/{id}', { path: taskPath, method: 'DELETE', token: tokOrg }, 204)
  await check('GET /api/v1/tasks/{id} (deleted)', { path: taskPath, token: tokOrg }, 404, (j) => eq(j.error.code, 'not_found', 'code'))
  await check('GET /api/v1/tasks (claim)', { path: '/api/v1/tasks', token: tokOrg }, 200, (j) =>
    j.data.some((t: { title: string }) => t.title === title) ? undefined : 'task missing',
  )
  await check('GET /api/v1/tasks (matching header, upper-case)', { path: '/api/v1/tasks', token: tokOrg, org: org1.id.toUpperCase() }, 200)
  await check('GET /api/v1/tasks (header: random uuid)', { path: '/api/v1/tasks', token: tokOrg, org: randomUUID() }, 403, (j) => eq(j.error.code, 'organization_forbidden', 'code'))
  await check('GET /api/v1/tasks (unmapped role)', { path: '/api/v1/tasks', token: await mint(subjectA, { org: { id: orgExt, rol: 'org:billing' } }) }, 403, (j) =>
    eq(j.error.code, 'organization_forbidden', 'code'),
  )
  await check('GET /api/v1/tasks (organisation Clerk does not have)', { path: '/api/v1/tasks', token: await mint(subjectA, { org: { id: `org_gone_${rand}`, rol: 'org:admin' } }) }, 403, (j) =>
    eq(j.error.code, 'organization_forbidden', 'code'),
  )
  await check('GET /meta/v1/me (wrong azp)', { path: '/meta/v1/me', token: await mint(subjectA, { azp: 'https://evil.example' }) }, 401, (j) => eq(j.error.code, 'unauthenticated', 'code'))
  await check('GET /meta/v1/me (expired)', { path: '/meta/v1/me', token: await mint(subjectA, { exp: Math.floor(Date.now() / 1000) - 60 }) }, 401)
  await check('GET /meta/v1/me (second subject, same email)', { path: '/meta/v1/me', token: await mint(subjectB) }, 409, (j) => eq(j.error.code, 'account_conflict', 'code'))
  // [[CORE36]]: the identity model over HTTP on Postgres: company, contact, resolve, merge, delete cascade, events.
  const company = await check('POST /api/v1/companies (mixed-case domain)', { path: '/api/v1/companies', method: 'POST', token: tokOrg, body: { name: 'Smoke Co', domain: ` Smoke-${rand}.EXAMPLE.com ` } }, 201, (j) =>
    eq(j.domain, `smoke-${rand}.example.com`, 'domain'),
  )
  await check('POST /api/v1/contacts (on the company)', { path: '/api/v1/contacts', method: 'POST', token: tokOrg, body: { name: 'Smoke Contact', company_id: company.id } }, 201)
  const r1 = await check('POST /api/v1/identities/resolve (first address)', { path: '/api/v1/identities/resolve', method: 'POST', token: tokOrg, body: { identities: [{ kind: 'email', value: `One-${rand}@Example.com` }] } }, 200, (j) =>
    eq(j.data.map((d: any) => d.created), [true], 'created'),
  )
  const r2 = await check('POST /api/v1/identities/resolve (second address)', { path: '/api/v1/identities/resolve', method: 'POST', token: tokOrg, body: { identities: [{ kind: 'email', value: `two-${rand}@example.com` }] } }, 200, (j) =>
    eq(j.data.map((d: any) => d.created), [true], 'created'),
  )
  const survivorId = r1.data[0].contact.id as string
  const sourceId = r2.data[0].contact.id as string
  await check('POST /api/v1/contacts/{id}/merge', { path: `/api/v1/contacts/${survivorId}/merge`, method: 'POST', token: tokOrg, body: { source_id: sourceId } }, 200, (j) => eq(j.id, survivorId, 'survivor'))
  await check('GET /api/v1/contacts/{source} (merged)', { path: `/api/v1/contacts/${sourceId}`, token: tokOrg }, 404, (j) => eq(j.error.code, 'not_found', 'code'))
  await check('DELETE /api/v1/companies/{id}', { path: `/api/v1/companies/${company.id}`, method: 'DELETE', token: tokOrg }, 204)
  // Set and count of the organisation's identity-model event types (never ctid order on a reused database).
  const events = await withOrganization(db, { principalId: me.user.id, organizationId: org1.id }, (trx) =>
    sql<{ type: string }>`SELECT type FROM events WHERE type LIKE 'company.%' OR type LIKE 'contact.%' OR type LIKE 'identity.%'`.execute(trx),
  )
  const tally: Record<string, number> = {}
  for (const e of events.rows) tally[e.type] = (tally[e.type] ?? 0) + 1
  const wanted = { 'company.created': 1, 'contact.created': 3, 'identity.created': 2, 'identity.updated': 1, 'contact.merged': 1, 'company.deleted': 1, 'contact.updated': 1 }
  const sortKeys = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort())
  const problem = eq(sortKeys(tally), sortKeys(wanted), 'event types')
  if (problem) failures++
  console.log(`${problem ? 'FAIL' : 'ok  '} identity-model events (${events.rows.length}) ${JSON.stringify(sortKeys(tally))}${problem ? ` (${problem})` : ''}`)
  const pre = await fetch(`${base}/tasks`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,x-organization-id' },
  })
  const allow = pre.headers.get('access-control-allow-origin')
  const corsOk = pre.status === 204 && allow === origin
  if (!corsOk) failures++
  console.log(`${corsOk ? 'ok  ' : 'FAIL'} OPTIONS /tasks (preflight) -> ${pre.status} allow-origin ${allow}`)
  console.log(`organization_id: ${org1.id}`)
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
