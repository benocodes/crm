// End-to-end smoke for [[CORE3]] authentication. Needs no Clerk account: it generates an RS256 key pair,
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
  req: { path: string; method?: string; scheme?: string; token?: string; org?: string; body?: unknown; origin?: string },
  expectStatus: number,
  verify?: (json: any, res: Response) => string | undefined,
): Promise<any> {
  const headers: Record<string, string> = {}
  if (req.token) headers.authorization = `${req.scheme ?? 'Bearer'} ${req.token}`
  if (req.org) headers['x-organization-id'] = req.org
  if (req.origin) {
    headers.origin = req.origin
    headers['access-control-request-method'] = 'GET'
  }
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
  const tokA = await mint(subjectA)
  const doc = await check('GET /openapi.json', { path: '/openapi.json' }, 200, (j) => {
    const ids = Object.values(j.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId))
    return ids.includes('me.get') && ids.includes('organizations.create') ? undefined : 'me.get / organizations.create missing'
  })
  void doc
  await check('GET /me (first sight)', { path: '/me', token: tokA }, 200, (j) =>
    eq(j.memberships, [], 'memberships') ?? eq(j.active_organization, null, 'active_organization') ?? (j.user.email_verified === true ? undefined : 'email_verified'),
  )
  await check('GET /me (lower-case scheme)', { path: '/me', token: tokA, scheme: 'bearer' }, 200)
  await check('GET /tasks (no organisation)', { path: '/tasks', token: tokA }, 403, (j) => eq(j.error.code, 'organization_required', 'code'))
  const org1 = await check('POST /organizations', { path: '/organizations', method: 'POST', token: tokA, body: { name: `Smoke ${rand}` } }, 201)
  await check('GET /me (owner of the new organisation)', { path: '/me', token: tokA }, 200, (j) =>
    eq(j.active_organization?.role, 'owner', 'role') ?? eq(j.active_organization?.scopes, declared, 'scopes'),
  )
  const title = `smoke task ${rand}`
  await check('POST /tasks', { path: '/tasks', method: 'POST', token: tokA, body: { title } }, 201)
  await check('GET /tasks (no header)', { path: '/tasks', token: tokA }, 200, (j) =>
    j.data.some((t: { title: string }) => t.title === title) ? undefined : 'task missing',
  )
  await check('POST /organizations (second)', { path: '/organizations', method: 'POST', token: tokA, body: { name: `Smoke ${rand} two` } }, 201)
  await check('GET /tasks (two organisations, no header)', { path: '/tasks', token: tokA }, 403, (j) => eq(j.error.code, 'organization_required', 'code'))
  await check('GET /tasks (header: first organisation)', { path: '/tasks', token: tokA, org: org1.id }, 200)
  await check('GET /tasks (header: random uuid)', { path: '/tasks', token: tokA, org: randomUUID() }, 403, (j) => eq(j.error.code, 'organization_forbidden', 'code'))
  await check('GET /me (wrong azp)', { path: '/me', token: await mint(subjectA, { azp: 'https://evil.example' }) }, 401, (j) => eq(j.error.code, 'unauthenticated', 'code'))
  await check('GET /me (expired)', { path: '/me', token: await mint(subjectA, { exp: Math.floor(Date.now() / 1000) - 60 }) }, 401)
  await check('GET /me (second subject, same email)', { path: '/me', token: await mint(subjectB) }, 409, (j) => eq(j.error.code, 'account_conflict', 'code'))
  const pre = await fetch(`${base}/tasks`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,x-organization-id' },
  })
  const allow = pre.headers.get('access-control-allow-origin')
  const corsOk = pre.status === 204 && allow === origin
  if (!corsOk) failures++
  console.log(`${corsOk ? 'ok  ' : 'FAIL'} OPTIONS /tasks (preflight) -> ${pre.status} allow-origin ${allow}`)
  console.log(`organization_id (first): ${org1.id}`)
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
