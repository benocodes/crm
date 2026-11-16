// [[OPS397]] P2, the cycle's premise: a Better Auth reset link on the `auth_users` row apply made (no `auth_accounts` row) lets the person set a password, and their next sign-in resolves to the RE-POINTED vault row
// (its original id, its membership role), with no new `users` row, no invitation and no new principal. The same holds for a relinked agent account (its `agents` row). Real apply, real Worker composition, real Better Auth.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAuth } from '@vibase/auth'
import { controlAuthDatabase, openControlDb, writeControlMarker, type D1Like } from '@vibase/storage-d1'
import { composeD1Worker } from '../src/compose.js'
import { AUTH_BASE, AUTH_SECRET } from '../src/test/auth-kit.js'
import { openWorkerPair, type WorkerPair } from '../src/test/kit.js'
import { applyBatches } from './auth-migrate/apply.js'
import {
  ORG_ID,
  clerkRowsOf,
  ids,
  planOf,
  readSnapshot,
  seedWorld,
  standardClerk,
  standardWorld,
} from './auth-migrate/test-kit.js'

const { U, A } = ids
let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(async () => {
  await pair.dispose()
})
afterEach(async () => {
  await pair.reset()
})
const rows = async (d1: D1Like, q: string, ...b: unknown[]) =>
  ((
    await d1
      .prepare(q)
      .bind(...b)
      .all()
  ).results ?? []) as Array<Record<string, any>>

async function applied() {
  const world = standardWorld()
  await seedWorld(pair.d1, world)
  await writeControlMarker(openControlDb(pair.control), ORG_ID)
  const snapshot = await readSnapshot(pair.d1, await clerkRowsOf(standardClerk()))
  const plan = planOf(snapshot)
  let n = 0
  await applyBatches({
    plan,
    fresh: snapshot,
    crm: pair.d1,
    control: pair.control,
    now: () => new Date('2026-11-17T09:00:00.000Z'),
    newId: () => `0190eeee-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  })
  return plan
}

let ip = 0
const worker = () =>
  composeD1Worker({
    DB: pair.d1,
    CONTROL_DB: pair.control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
  })
const post = (wk: ReturnType<typeof worker>, path: string, body: unknown) =>
  wk.fetch(
    new Request(AUTH_BASE + path, {
      method: 'POST',
      headers: { origin: AUTH_BASE, 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${++ip}` },
      body: JSON.stringify(body),
    }),
  )

/** reset link -> new password -> sign in -> session JWT -> /meta/v1/me */
async function claimAndSignIn(email: string) {
  const auth = createAuth(controlAuthDatabase(openControlDb(pair.control)), { secret: AUTH_SECRET, baseURL: AUTH_BASE })
  expect(await rows(pair.control, 'select id from auth_accounts')).toEqual([])
  const issued = await auth.issueResetToken(email)
  expect(issued, 'a reset token for an account with no credential').not.toBeNull()
  const wk = worker()
  const done = await post(wk, '/auth/reset-password', { token: issued!.token, newPassword: 'a brand new password 456' })
  expect(done.status, await done.clone().text()).toBe(200)
  const signIn = await post(wk, '/auth/sign-in/email', { email, password: 'a brand new password 456' })
  expect(signIn.status, await signIn.clone().text()).toBe(200)
  const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!
  const tokRes = await wk.fetch(new Request(`${AUTH_BASE}/auth/token`, { headers: { cookie, origin: AUTH_BASE } }))
  expect(tokRes.status).toBe(200)
  const token = ((await tokRes.json()) as { token: string }).token
  const me = await wk.fetch(new Request(`${AUTH_BASE}/meta/v1/me`, { headers: { authorization: `Bearer ${token}` } }))
  return { status: me.status, json: (await me.json()) as any }
}
const counts = async () => ({
  users: await rows(pair.d1, 'select count(*) n from users'),
  principals: await rows(pair.d1, 'select count(*) n from principals'),
  agents: await rows(pair.d1, 'select count(*) n from agents'),
  memberships: await rows(pair.d1, 'select count(*) n from memberships'),
  invitations: await rows(pair.control, 'select count(*) n from invitations'),
})

describe('P2 premise: a claim link signs the original identity in', () => {
  it('a migrated person sets a password and signs in as their ORIGINAL users row and role, nothing new created', async () => {
    await applied()
    const before = await counts()
    const me = await claimAndSignIn('a@example.test')
    expect(me.status, JSON.stringify(me.json)).toBe(200)
    expect([me.json.principal, me.json.user.id, me.json.active_organization.role]).toEqual([
      { id: U(1), kind: 'user' },
      U(1),
      'owner',
    ])
    expect(await counts()).toEqual(before)
  })
  it('a relinked agent account signs in as its ORIGINAL agents row, nothing new created', async () => {
    await applied()
    const before = await counts()
    const me = await claimAndSignIn('c@example.test')
    expect(me.status, JSON.stringify(me.json)).toBe(200)
    expect([me.json.principal, me.json.agent.id]).toEqual([{ id: A(2), kind: 'agent' }, A(2)])
    expect(await counts()).toEqual(before)
  })
})
