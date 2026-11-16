import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { openControlDb, writeControlMarker, type D1Like } from '@vibase/storage-d1'
import { bootstrapD1 } from './bootstrap-d1.js'
import { openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE356]] groups 1 and 2 at `bootstrapD1`: every provider path mints its key on the control plane (the key and one `api_key.created` audit row), none in the CRM, refusals write nothing to either store, and a
// control failure after the CRM commit fails the run with the recovery message and a re-run writes nothing to control.
let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(() => pair.dispose())
afterEach(() => pair.reset())

const NOW = new Date('2026-11-16T10:00:00.000Z')
const env = (control: D1Like = pair.control) => ({
  now: NOW,
  newId: () => uuidv7(NOW),
  control: openControlDb(control),
})
const rows = async (db: D1Like, q: string) => ((await db.prepare(q).all()).results ?? []) as Array<Record<string, any>>
const counts = async () => ({
  ctlKeys: (await rows(pair.control, 'select * from api_keys')).length,
  audit: (await rows(pair.control, 'select * from control_audit')).length,
  orgs: (await rows(pair.d1, 'select * from organizations')).length,
  events: (await rows(pair.d1, 'select * from events')).length,
})
const base = { organizationName: 'Acme' }
const PATHS = {
  none: { ...base, authProvider: 'none', authOrgId: 'demo', email: 'Owner@Acme.test', agentName: 'bot' },
  clerk: { ...base, authOrgId: 'https://clerk.test.example', agentName: 'bot' },
  'better-auth': {
    ...base,
    authProvider: 'better-auth',
    authOrgId: 'better-auth',
    publicBaseUrl: 'https://vibase.test',
    agentName: 'bot',
  },
} as const

describe('each bootstrap path mints its key on the control plane (CORE356 group 1)', () => {
  it.each(['none', 'clerk', 'better-auth'] as const)('%s with an agent', async (path) => {
    const r = await bootstrapD1(pair.d1, PATHS[path], env())
    expect(r.key).toMatch(/^vk_/)
    expect(await counts()).toEqual({ ctlKeys: 1, audit: 1, orgs: 1, events: 0 })
    const [key] = await rows(pair.control, 'select * from api_keys')
    expect(key).toMatchObject({ id: r.apiKeyId, agent_id: r.agentId, organization_id: r.organizationId })
    const actor =
      path === 'none'
        ? r.userId
        : ((await rows(pair.d1, "select id from principals where kind = 'system'"))[0]!.id as string)
    expect(key!.created_by).toBe(actor)
    const [audit] = await rows(pair.control, 'select * from control_audit')
    expect(audit).toMatchObject({
      action: 'api_key.created',
      actor_id: actor,
      target_type: 'api_key',
      target_id: r.apiKeyId,
    })
    expect(JSON.stringify([key, audit])).not.toContain(r.key!)
  })

  it.each(['clerk', 'better-auth'] as const)('%s without an agent writes no key and no control row', async (path) => {
    const { agentName: _a, ...noAgent } = PATHS[path]
    const r = await bootstrapD1(pair.d1, noAgent, env())
    expect(r.key).toBeNull()
    expect(await counts()).toEqual({ ctlKeys: 0, audit: 0, orgs: 1, events: 0 })
  })

  it('better-auth re-run converges and writes no second key', async () => {
    await bootstrapD1(pair.d1, PATHS['better-auth'], env())
    const before = await counts()
    const again = await bootstrapD1(pair.d1, PATHS['better-auth'], env())
    expect(again).toMatchObject({ organizationExisted: true, key: null })
    expect(await counts()).toEqual(before)
  })
})

describe('order and partial states (CORE356 group 2)', () => {
  it('a refusal leaves both stores unchanged: existing organisation, unknown scope, ungrantable scope, a marker for another organisation, a missing control database', async () => {
    await bootstrapD1(pair.d1, PATHS.clerk, env())
    const before = await counts()
    await expect(bootstrapD1(pair.d1, PATHS.clerk, env())).rejects.toThrow(/already initialised/)
    expect(await counts()).toEqual(before)
    await pair.reset()
    const empty = await counts()
    await expect(bootstrapD1(pair.d1, { ...PATHS.clerk, scopes: ['nope:read'] }, env())).rejects.toThrow(
      /unknown scope/,
    )
    await expect(bootstrapD1(pair.d1, { ...PATHS.clerk, scopes: ['agents:write'] }, env())).rejects.toThrow()
    expect(await counts()).toEqual(empty)
    // (The deployment and control markers are resumable machinery and stay; no key or audit row is written.)
    await pair.reset()
    await writeControlMarker(openControlDb(pair.control), uuidv7(NOW))
    const marked = await counts()
    await expect(bootstrapD1(pair.d1, PATHS.clerk, env())).rejects.toThrow(/already paired with organization/)
    expect(await counts()).toEqual(marked)
    await pair.reset()
    // No control database: a key cannot be minted, and neither store is written (not even the deployment marker).
    const { control: _c, ...noControl } = env()
    await expect(bootstrapD1(pair.d1, PATHS.clerk, noControl)).rejects.toThrow(/control/i)
    expect(await counts()).toEqual(empty)
    expect(await rows(pair.d1, 'select * from deployment')).toEqual([])
  })

  const failing = (): D1Like => ({
    prepare: (q: string) => {
      if (/insert into api_keys/i.test(q)) throw new Error('control is down')
      return pair.control.prepare(q)
    },
    batch: (b) => pair.control.batch(b),
  })

  it.each(['none', 'clerk', 'better-auth'] as const)(
    '%s: a control insert that fails after the CRM commit fails the run naming the recovery, and a re-run writes nothing to control',
    async (path) => {
      let thrown: Error | undefined
      try {
        await bootstrapD1(pair.d1, PATHS[path], env(failing()))
      } catch (e) {
        thrown = e as Error
      }
      expect(thrown?.message).toMatch(/no key/)
      expect(thrown?.message).toMatch(/api_keys\.create/)
      const [org] = await rows(pair.d1, 'select id from organizations')
      const [agent] = await rows(pair.d1, 'select id from agents')
      expect(thrown?.message).toContain(org!.id)
      expect(thrown?.message).toContain(agent!.id)
      expect(await counts()).toEqual({ ctlKeys: 0, audit: 0, orgs: 1, events: 0 })
      if (path === 'better-auth') {
        const again = await bootstrapD1(pair.d1, PATHS[path], env())
        expect(again).toMatchObject({ organizationExisted: true, key: null })
      } else {
        await expect(bootstrapD1(pair.d1, PATHS[path], env())).rejects.toThrow(/already initialised/)
      }
      expect(await counts()).toEqual({ ctlKeys: 0, audit: 0, orgs: 1, events: 0 })
    },
  )
})
