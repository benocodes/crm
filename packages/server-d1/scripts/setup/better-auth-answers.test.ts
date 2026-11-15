// OPS306 obligation 1: the kits' fake answers for `better-auth` (test/better-auth-answers.ts) equal what the real Worker (`composeD1Worker` on `better-auth` vars, in-process) answers,
// so the fake cannot drift from the real shape. Both setup front-ends' kits build their answers from these builders.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { bootstrapD1 } from '../../src/bootstrap-d1.js'
import { composeD1Worker } from '../../src/compose.js'
import { AUTH_BASE, AUTH_SECRET } from '../../src/test/auth-kit.js'
import { NOW, openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { discoveryAnswer, metadataAnswer } from './test/better-auth-answers.js'

let w: WorkerPair
beforeAll(async () => {
  w = await openWorkerPair()
}, 60_000)
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(
    w.d1,
    MIGRATIONS.map((m) => m.name),
  )
  await bootstrapD1(
    w.d1,
    { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: AUTH_BASE },
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) },
  )
})

const get = async (path: string, over: Record<string, string> = {}) => {
  const res = await composeD1Worker({
    DB: w.d1,
    CONTROL_DB: w.control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
    ...over,
  }).fetch(new Request(AUTH_BASE + path))
  return { status: res.status, json: (await res.json()) as any }
}

describe("the kit answers are the Worker's", () => {
  it('/.well-known/vibase: the auth block is exactly the fake one (password only)', async () => {
    const r = await get('/.well-known/vibase')
    expect(r.status).toBe(200)
    expect(r.json.auth).toEqual(discoveryAnswer(AUTH_BASE).auth)
  })
  it('/.well-known/vibase with the Google pair: sign_in_methods carries google, as the fake with ["password","google"]', async () => {
    const r = await get('/.well-known/vibase', { AUTH_GOOGLE_CLIENT_ID: 'gid', AUTH_GOOGLE_CLIENT_SECRET: 'gsecret' })
    expect(r.json.auth).toEqual(discoveryAnswer(AUTH_BASE, r.json.auth.sign_in_methods).auth)
    expect(r.json.auth.sign_in_methods).toContain('google')
  })
  it('the RFC 8414 metadata names the same issuer as the fake (the fake carries the part verify reads)', async () => {
    const r = await get('/.well-known/oauth-authorization-server/auth')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject(metadataAnswer(AUTH_BASE))
  })
})
