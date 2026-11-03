import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { composeD1Worker } from '@vault/server-d1/compose'
import { bootstrapD1 } from '@vault/server-d1/bootstrap'
import { clerkKit, clerkUser, mintOAuthToken, openWorkerD1, type ClerkKit, type WorkerD1 } from '@vault/server-d1/test'
import { fakeIssuer, network } from './test/fake-issuer.js'
import { rig } from './test/harness.js'

// [[API104]]: device login against the real D1 app's token verification and `me` ([[CORE64]], [[CORE77]]). The fake authorization
// server signs JWT access tokens with the key the in-process Worker trusts; Clerk's Backend API is the kit's fake.

const SERVER = 'https://w.test'
const CLI = 'client_cli'
let w: WorkerD1
let kit: ClerkKit
beforeAll(async () => {
  w = await openWorkerD1()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})
beforeEach(async () => {
  await w.reset()
  kit.fetch.reset()
  kit.profiles.clear()
  await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'clerk', authOrgId: kit.issuer.issuer })
  kit.profiles.set('user_o', clerkUser({ id: 'user_o', email: 'o@x.test', verified: true, role: 'owner' }))
  kit.profiles.set('user_g', clerkUser({ id: 'user_g', email: 'g@x.test', verified: true, role: 'agent', first: 'Robo', last: 'Tron' }))
})

function session(subject: string) {
  const iss = fakeIssuer({
    origin: kit.issuer.issuer,
    clientId: CLI,
    subject,
    mint: ({ sub, scope }) => mintOAuthToken(kit.issuer, { sub, clientId: CLI, scope }),
  })
  const worker = composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, AUTH_CLI_CLIENT_ID: CLI }, { fetch: kit.fetch })
  const net = network({ [SERVER]: (req) => worker.fetch(req), [iss.origin]: iss.handler })
  const r = rig({ fetch: net.fetch })
  rigs.push(r)
  return { iss, net, r }
}
const clean = (s: ReturnType<typeof session>, ...res: { stdout: string; stderr: string }[]) => {
  for (const x of res) for (const t of s.iss.secrets()) {
    expect(x.stdout).not.toContain(t)
    expect(x.stderr).not.toContain(t)
  }
}

describe('who signs in (D14, D17)', () => {
  it('an owner prints me as a user, with the role scopes, and asks for no grant', async () => {
    const s = session('user_o')
    const res = await s.r.run(['login', '--server', SERVER])
    expect(res.code).toBe(0)
    const me = JSON.parse(res.stdout)
    expect(me.principal.kind).toBe('user')
    expect(me.active_organization.role).toBe('owner')
    expect(me.active_organization.scopes.length).toBeGreaterThan(0)
    expect(res.stderr).not.toContain('vibase agents update')
    // the default scopes came from the real protected-resource document: every declared scope
    const asked = new URLSearchParams(s.net.at(kit.issuer.issuer, '/oauth/device_authorization')[0]!.body).get('scope')!.split(' ')
    expect(asked).toContain('offline_access')
    expect(asked).toContain('contacts:read')
    expect(asked.length).toBeGreaterThan(10)
    // and the stored token works for a command
    const list = await s.r.run(['contacts', 'create', '--name', 'Ada'])
    expect(list.code).toBe(0)
    clean(s, res, list)
  })

  it('a vibase_role: agent subject prints me as that agent with no scopes, and the stderr hint says an owner must grant them', async () => {
    const s = session('user_g')
    const res = await s.r.run(['login', '--server', SERVER])
    expect(res.code).toBe(0)
    const me = JSON.parse(res.stdout)
    expect(me.principal.kind).toBe('agent')
    expect(me.agent).toMatchObject({ name: 'Robo Tron', auth_subject: 'user_g' })
    expect(me.active_organization.scopes).toEqual([])
    expect(res.stderr).toMatch(/owner/)
    expect(res.stderr).toContain('vibase agents update')
    expect(res.stderr).toContain(me.principal.id)
    const denied = await s.r.run(['contacts', 'list'])
    expect(denied.code).toBe(1)
    expect(JSON.parse(denied.stderr).error.code).toBe('insufficient_scope')
    clean(s, res, denied)
  })

  it('a refresh through the real token verification: the rotated token is accepted', async () => {
    const s = session('user_o')
    await s.r.run(['login', '--server', SERVER])
    s.r.advance(3600_000 + 1000)
    const res = await s.r.run(['me', 'get'])
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout).principal.kind).toBe('user')
    expect(s.iss.refreshCalls()).toBe(1)
  })
})
