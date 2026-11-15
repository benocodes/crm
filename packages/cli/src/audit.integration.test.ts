import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { composeD1Worker } from '@vibase/server-d1/compose'
import { bootstrapD1 } from '@vibase/server-d1/bootstrap'
import { openWorkerPair, type WorkerPair } from '@vibase/server-d1/test'
import { rig, SERVER } from './test/harness.js'

// [[CORE261]] P1: `vibase audit list` is derived from the registry's operation; here it runs against the real Worker (`better-auth`, with the control-plane database) with an API-key agent holding audit:read.
let w: WorkerPair
let key: string
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
  const b = await bootstrapD1(w.d1, {
    organizationName: 'Acme',
    authProvider: 'none',
    authOrgId: 'e2e',
    email: 'e2e@example.com',
    agentName: 'auditor',
    scopes: ['audit:read'],
  })
  key = b.key
})

it('audit list answers the control-plane log, filters by flag, and the command is derived (listed in the resource help)', async () => {
  const actor = '0190b2c4-0000-7000-8000-00000000b001'
  let n = 0
  const id = () => `0190b2c4-0000-7000-8000-${String(++n).padStart(12, '0')}`
  for (const [action, target] of [
    ['invitation.created', 'cli-1'],
    ['invitation.revoked', 'cli-1'],
    ['user.sessions_revoked', 'cli-2'],
  ] as const)
    await w.control
      .prepare(
        'insert into control_audit (id, at, actor_id, action, target_type, target_id, detail) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id(), new Date().toISOString(), actor, action, 'thing', target, '{"k":"v"}')
      .run()
  const worker = composeD1Worker({
    DB: w.d1,
    CONTROL_DB: w.control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET: 'x'.repeat(40),
    PUBLIC_BASE_URL: SERVER,
  })
  const r = rig({ fetch: (req) => worker.fetch(req) })
  rigs.push(r)
  expect((await r.run(['login', '--api-key', '--server', SERVER], { stdin: key + '\n' })).code).toBe(0)
  const all = await r.run(['audit', 'list'])
  expect(all.stderr).toBe('')
  expect(all.code).toBe(0)
  const body = JSON.parse(all.stdout)
  expect(body.data.map((x: any) => x.action)).toEqual([
    'invitation.created',
    'invitation.revoked',
    'user.sessions_revoked',
  ])
  expect(body.data[0].detail).toEqual({ k: 'v' })
  const some = await r.run(['audit', 'list', '--target-id', 'cli-1', '--action', 'invitation.revoked', '--limit', '5'])
  expect(some.code, some.stderr).toBe(0)
  expect(JSON.parse(some.stdout).data).toHaveLength(1)
  expect(some.stdout).not.toContain(key)
  const help = await r.run(['audit', 'list', '--help'])
  expect(help.stdout).toMatch(/--target-id/)
  expect(help.stdout).toMatch(/--action/)
})
