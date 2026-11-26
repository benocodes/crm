import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { composeD1Worker } from '@vibase/server-d1/compose'
import { bootstrapD1 } from '@vibase/server-d1/bootstrap'
import {
  AUTH_BASE,
  AUTH_SECRET,
  authKit,
  openControlDb,
  openWorkerPair,
  seedAgent,
  seedMembership,
  seedPrincipal,
  type WorkerPair,
} from '@vibase/server-d1/test'
import { rig } from './test/harness.js'

// [[CORE662]] (CORE630 D4, D8, D10, D11) through the CLI against the real Worker (`better-auth`): `vibase login` runs the REAL device flow (the Worker's own Better Auth, the page's claim and approval made
// by the test with the account's cookie when the CLI first waits), and every token the later commands send came out of it.
let w: WorkerPair
let orgId: string
let bootUser: string
let n = 0
const id = () => `0190b2c4-0000-7000-8000-${String(++n).padStart(12, '0')}`
const rigs: ReturnType<typeof rig>[] = []
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})
beforeEach(async () => {
  await w.reset()
  const b = await bootstrapD1(
    w.d1,
    { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: AUTH_BASE },
    { control: openControlDb(w.control) },
  )
  orgId = b.organizationId
  bootUser = id()
  await seedPrincipal(w.d1, { id: bootUser, kind: 'user', email: 'boot@x.test' })
})

async function owner() {
  const kit = authKit(w.control)
  const { userId, cookie } = await kit.signUp(`owner-${++n}@x.test`)
  const uid = id()
  await seedPrincipal(w.d1, {
    id: uid,
    kind: 'user',
    email: `owner-${n}@x.test`,
    authProvider: 'better-auth',
    authSubject: userId,
  })
  await seedMembership(w.d1, { organizationId: orgId, userId: uid, role: 'owner' })
  return { cookie, id: uid }
}
async function agentAccount(scopes: string[]) {
  const kit = authKit(w.control)
  const { userId, cookie } = await kit.signUp(`agent-${++n}@x.test`)
  const aid = id()
  await seedAgent(w.d1, { id: aid, organizationId: orgId, createdBy: bootUser, scopes })
  await w.d1
    .prepare('update agents set auth_provider = ?, auth_subject = ? where id = ?')
    .bind('better-auth', userId, aid)
    .run()
  return { cookie, id: aid }
}

/** A CLI rig on the Worker; `login(cookie, args)` runs `vibase login` and approves the device code as that account at the CLI's first wait. */
function cli() {
  const worker = composeD1Worker({
    DB: w.d1,
    CONTROL_DB: w.control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
  })
  let userCode = ''
  const r = rig({
    fetch: async (req) => {
      const res = await worker.fetch(req)
      if (new URL(req.url).pathname === '/auth/device/code') userCode = ((await res.clone().json()) as any).user_code
      return res
    },
  })
  rigs.push(r)
  const page = (path: string, cookie: string, body?: unknown) =>
    worker.fetch(
      new Request(AUTH_BASE + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          origin: AUTH_BASE,
          'cf-connecting-ip': `198.51.100.${(++n % 200) + 1}`,
          cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
  const login = async (cookie: string, args: string[] = []) => {
    let approved = false
    return r.run(['login', '--server', AUTH_BASE, ...args], {
      sleep: async () => {
        if (approved) return
        approved = true
        expect((await page(`/auth/device?user_code=${userCode}`, cookie)).status).toBe(200)
        expect((await page('/auth/device/approve', cookie, { userCode })).status).toBe(200)
      },
    })
  }
  return { r, login }
}

describe('the CLI of an agent account (D4, D8, D11)', () => {
  it('an agent with no grant signs in with no scope, and the after-login line says to sign in again once granted', async () => {
    const a = await agentAccount([])
    const c = cli()
    const res = await c.login(a.cookie)
    expect(res.code, res.stderr).toBe(0)
    const me = JSON.parse(res.stdout)
    expect(me.principal.id).toBe(a.id)
    expect(me.active_organization.scopes).toEqual([])
    expect(res.stderr).toContain('has no scopes yet')
    // the line names the command to run once granted, after saying the agent has no scopes (its wording is the coder's, not pinned)
    expect(res.stderr.slice(res.stderr.indexOf('has no scopes yet'))).toContain('`vibase login`')
  })

  it('a default login holds the record only, and a refusal for a scope granted later prints the hint with the exact command on stderr', async () => {
    const a = await agentAccount(['tags:read'])
    const c = cli()
    const res = await c.login(a.cookie)
    expect(res.code, res.stderr).toBe(0)
    expect(JSON.parse(res.stdout).active_organization.scopes).toEqual(['tags:read'])
    // the owner grants contacts:write afterwards: the live record holds it, the token (made before) does not
    await w.d1
      .prepare('update agents set scopes = ? where id = ?')
      .bind(JSON.stringify(['tags:read', 'contacts:write']), a.id)
      .run()
    const refused = await c.r.run(['contacts', 'create', '--name', 'Ada'])
    expect(refused.code).toBe(1)
    const body = JSON.parse(refused.stderr)
    expect(body.error.code).toBe('insufficient_scope')
    expect(body.error.message).toBe(
      'requires contacts:write; this sign-in was made before contacts:write was granted to this agent: sign in again as the agent with `vibase login`',
    )
    expect(refused.stderr).toContain('`vibase login`')
    // signing in again holds it
    expect((await c.login(a.cookie)).code).toBe(0)
    expect((await c.r.run(['contacts', 'create', '--name', 'Ada'])).code).toBe(0)
  })
})

describe('the owner on the CLI (D10)', () => {
  it('agents update prints the notice after the record, on stderr, when a scope is added to an agent account; nothing when it only removes', async () => {
    const o = await owner()
    const a = await agentAccount(['tags:read'])
    const c = cli()
    expect((await c.login(o.cookie)).code).toBe(0)
    const added = await c.r.run(['agents', 'update', a.id, '--add-scopes', '["contacts:write"]'])
    expect(added.code, added.stderr).toBe(0)
    const record = JSON.parse(added.stdout)
    expect(record.id).toBe(a.id)
    expect(typeof record.sign_in_notice).toBe('string')
    expect(added.stderr).toContain(record.sign_in_notice)
    const removed = await c.r.run(['agents', 'update', a.id, '--remove-scopes', '["contacts:write"]'])
    expect(removed.code, removed.stderr).toBe(0)
    expect(JSON.parse(removed.stdout).sign_in_notice).toBeNull()
    expect(removed.stderr).toBe('')
  })
  it("agents update refuses a scope outside a connector's consent: exit 1 (the CLI's refusal exit), the message on stderr, nothing written ([[CORE669]] D5)", async () => {
    const o = await owner()
    const d = id()
    await seedAgent(w.d1, { id: d, organizationId: orgId, createdBy: bootUser, scopes: ['tags:read'] })
    const human = (await w.d1.prepare('select id from users limit 1').first()) as { id: string }
    await w.d1
      .prepare(
        'update agents set auth_provider = ?, auth_client_id = ?, delegated_by = ?, consented_scopes = ? where id = ?',
      )
      .bind('better-auth', 'client_cli', human.id, JSON.stringify(['tags:read']), d)
      .run()
    const c = cli()
    expect((await c.login(o.cookie)).code).toBe(0)
    const refused = await c.r.run(['agents', 'update', d, '--add-scopes', '["contacts:write"]'])
    expect(refused.code).toBe(1)
    const body = JSON.parse(refused.stderr)
    expect(body.error.code).toBe('scope_not_consented')
    expect(body.error.message).toContain('contacts:write was not approved when this connector signed in')
    const row = (await w.d1.prepare('select scopes from agents where id = ?').bind(d).first()) as { scopes: string }
    expect(JSON.parse(row.scopes)).toEqual(['tags:read'])
  })
})
