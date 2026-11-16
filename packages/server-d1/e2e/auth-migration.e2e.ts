// [[OPS397]] E2E: the whole hq auth migration, locally: plan, apply, claim, sign in, and an old event keeps its actor. One serial scenario.
// What is real: the script's own `plan`, `apply` and `claim` code (`e2e/auth-migration-driver.ts` swaps `withDatabases`, `exec`, `deploy`, `run`, `readConfig`, `git`, `appendEnvVar` and `readInstanceEnv`, and the Worker runs on plain http://localhost; see its header), the Clerk DEVELOPMENT instance (Backend API: users, sessions, the export), the local Worker
// (first on Clerk, then, after `apply`, on Better Auth) and the browser that opens a claim link. Keys come from `.env.dev` only (`playwright.auth-migration.config.ts`); nothing reads the root `.env` or an `.env.hq*` file.
// Prerequisites: `pnpm -C packages/server-d1 build` (the auth pages), and a free port (E2E_PORT, default 8787). No other setup: the spec migrates and bootstraps its own local state in a temp directory and removes it, and deletes its Clerk test users, even when it fails.
// Run: E2E_DEV_ENV_FILE=<path to .env.dev> [E2E_BROWSER_CHANNEL=chrome] pnpm -C packages/server-d1 e2e:auth-migration
// Deviations from the charter's recipe, recorded as decisions: Clerk sessions come from the Backend API (`POST /v1/sessions`, then `/tokens`: a dev-instance JWT with the `vibase_role` claim) instead of `@clerk/testing`'s browser sign-in, and the pre-cutover event is a contact's.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { LocalInstance, ENV_NAME } from './auth-migration-driver.js'

const SECRET = process.env.CLERK_SECRET_KEY!
const PORT = Number(process.env.E2E_PORT ?? '8787')
const BAPI = 'https://api.clerk.com/v1'
const stamp = Date.now()
const NEW_PASSWORD = 'a brand new password 456'
type Who = 'owner' | 'member'
const people: Record<Who, { email: string; clerkId?: string; userId?: string }> = {
  owner: { email: `vb397-${stamp}-o+clerk_test@example.com` },
  member: { email: `vb397-${stamp}-m+clerk_test@example.com` },
}
let inst: LocalInstance
let planPath: string
let contactId: string
let contactEvent: { id: string; actor_id: string }
const links: Record<string, string> = {}
const URL_RE = /https?:\/\/\S+#token=[A-Za-z0-9_-]+/

const bapi = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BAPI}${path}`, {
    method,
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ok: res.ok, status: res.status, json: (await res.json().catch(() => null)) as any }
}
/** A Clerk session JWT for a test user: created by the Backend API, with the dev instance's session claims (`vibase_role`). */
async function clerkJwt(clerkId: string): Promise<string> {
  const s = await bapi('POST', '/sessions', { user_id: clerkId })
  expect(s.ok, `create session: ${s.status}`).toBe(true)
  const t = await bapi('POST', `/sessions/${s.json.id}/tokens`, {})
  expect(t.ok, `session token: ${t.status}`).toBe(true)
  return t.json.jwt as string
}
const get = async (path: string, token: string) => {
  const res = await fetch(`${inst.base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}
const visit = async (page: Page, url: string) => {
  await page.goto('about:blank')
  await page.goto(url)
}
const linkFor = (out: string[], email: string) =>
  URL_RE.exec(out.find((l) => l.includes(email) && URL_RE.test(l)) ?? '')?.[0]

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  inst = new LocalInstance(mkdtempSync(join(tmpdir(), 'vb-auth-migration-')), PORT, {
    secretKey: SECRET,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
    issuer: process.env.E2E_CLERK_ISSUER!,
    jwtKey: process.env.CLERK_JWT_KEY!,
  })
  planPath = join(inst.dir, 'e2e.auth-plan.json')
  for (const who of Object.keys(people) as Who[]) {
    const u = await bapi('POST', '/users', {
      email_address: [people[who].email],
      skip_password_requirement: true,
      public_metadata: { vibase_role: who },
    })
    expect(u.ok, `create ${who}: ${u.status}`).toBe(true)
    people[who].clerkId = u.json.id
  }
  await inst.setUp()
  await inst.startWorker()
})
test.afterAll(async () => {
  for (const p of Object.values(people)) if (p.clerkId) await bapi('DELETE', `/users/${p.clerkId}`)
  await inst?.tearDown()
})

test('1. initial state: both Clerk users sign in once (first sight writes their users rows), the owner creates a contact, the operator key answers', async () => {
  for (const who of Object.keys(people) as Who[]) {
    const me = await get('/meta/v1/me', await clerkJwt(people[who].clerkId!))
    expect(me.status, JSON.stringify(me.json)).toBe(200)
    people[who].userId = me.json.user.id
  }
  const owner = await get('/meta/v1/me', await clerkJwt(people.owner.clerkId!))
  expect(owner.json.active_organization.role).toBe('owner')
  const created = await fetch(`${inst.base}/api/v1/contacts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await clerkJwt(people.owner.clerkId!)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Pre-cutover ${stamp}` }),
  })
  expect(created.status).toBe(201)
  contactId = ((await created.json()) as { id: string }).id
  const ev = inst.sql(
    'DB',
    `select id, actor_id from events where type = 'contact.created' and resource_id = '${contactId}'`,
  )
  expect(ev).toHaveLength(1)
  contactEvent = ev[0] as { id: string; actor_id: string }
  expect(contactEvent.actor_id).toBe(people.owner.userId)
  expect((await get('/api/v1/contacts', inst.operatorKey!)).status).toBe(200)
})

test('2. plan lists both people as migrate and writes the plan file', async () => {
  const r = await inst.run(['plan', '--env', ENV_NAME, '--plan', planPath])
  expect(r.code, [...r.out, ...r.err].join('\n')).toBe(0)
  const plan = JSON.parse(readFileSync(planPath, 'utf8'))
  const migrate = plan.people
    .filter((p: any) => p.action === 'migrate')
    .map((p: any) => p.email)
    .sort()
  expect(migrate).toEqual([people.member.email, people.owner.email].sort())
  expect(plan.people.map((p: any) => p.user_id).sort()).toEqual([people.member.userId, people.owner.userId].sort())
})

test('3. apply --dry-run writes nothing; apply exits 0 and the marker reads better-auth', async () => {
  inst.record = 'better-auth' // the operator's commit of the provider switch
  const dry = await inst.run(['apply', '--env', ENV_NAME, '--plan', planPath, '--dry-run'])
  expect(dry.code, [...dry.out, ...dry.err].join('\n')).toBe(0)
  expect(inst.sql('DB', 'select auth_provider from deployment')).toEqual([{ auth_provider: 'clerk' }])
  expect(inst.sql('CONTROL_DB', 'select count(*) as n from auth_users')).toEqual([{ n: 0 }])
  const r = await inst.run(['apply', '--env', ENV_NAME, '--plan', planPath])
  expect(r.code, [...r.out, ...r.err].join('\n')).toBe(0)
  expect(r.out.join('\n')).toMatch(/next: CONFIRM_REMOTE=1 .* claim --env e2e/)
  expect(inst.sql('DB', 'select auth_provider from deployment')).toEqual([{ auth_provider: 'better-auth' }])
  expect(inst.workerMode).toBe('better-auth')
  expect(((await (await fetch(`${inst.base}/.well-known/vibase`)).json()) as any).auth.provider).toBe('better-auth')
})

test('4. claim prints two links and records two user.reset_link_issued rows', async () => {
  const r = await inst.run(['claim', '--env', ENV_NAME, '--plan', planPath])
  expect(r.code, [...r.out, ...r.err].join('\n')).toBe(0)
  for (const who of Object.keys(people) as Who[]) links[who] = linkFor(r.out, people[who].email)!
  expect(Object.values(links).every(Boolean), r.out.join('\n')).toBe(true)
  expect(r.out.filter((l) => URL_RE.test(l))).toHaveLength(2)
  const audit = inst.sql('CONTROL_DB', "select target_id from control_audit where action = 'user.reset_link_issued'")
  expect(audit).toHaveLength(2)
})

test('5. the owner opens the link in the browser, sets a password and signs in as the ORIGINAL identity', async ({
  page,
}) => {
  await visit(page, links.owner!)
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Set new password' }).click()
  await page.waitForURL('**/sign-in?notice=password-reset')
  await page.getByLabel('Email').fill(people.owner.email)
  await page.getByLabel('Password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // the form sends a signed-in browser on to the connect page (or shows who is signed in): either way the session cookie now answers /auth/token
  // (read through the context's request, which shares the cookie and survives that navigation)
  await expect
    .poll(async () => (await page.context().request.get('/auth/token')).status(), { timeout: 30_000 })
    .toBe(200)
  const token = ((await (await page.context().request.get('/auth/token')).json()) as { token: string }).token
  const me = await get('/meta/v1/me', token)
  expect(me.status, JSON.stringify(me.json)).toBe(200)
  expect(me.json.user.id).toBe(people.owner.userId)
  expect(me.json.active_organization.role).toBe('owner')
  expect(inst.sql('DB', 'select count(*) as n from users')).toEqual([{ n: 2 }])
})

test("6. the pre-cutover event still names the owner's original principal; the operator key still answers 200", async () => {
  const ev = inst.sql('DB', `select actor_id from events where id = '${contactEvent.id}'`)
  expect(ev).toEqual([{ actor_id: people.owner.userId }])
  expect((await get('/api/v1/contacts', inst.operatorKey!)).status).toBe(200)
})

test('7. a second claim lists the owner as claimed and issues one fresh link, for the member', async () => {
  const r = await inst.run(['claim', '--env', ENV_NAME, '--plan', planPath])
  expect(r.code, [...r.out, ...r.err].join('\n')).toBe(0)
  const text = r.out.join('\n')
  expect(r.out.filter((l) => URL_RE.test(l))).toHaveLength(1)
  expect(linkFor(r.out, people.member.email)).toBeTruthy()
  expect(linkFor(r.out, people.owner.email)).toBeUndefined()
  expect(text).toMatch(new RegExp(`already claimed: ${people.owner.email.replace(/[+.]/g, '\\$&')}`))
})
