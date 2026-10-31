import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execute, uuidv7 } from '@vault/storage'
import { d1Binding } from '@vault/storage-d1'
import { authenticateApiKey, hashApiKey } from '@vault/api'
import { bootstrapD1, probeBatchAtomicity } from './bootstrap-d1.js'
import { composeD1Worker } from './compose.js'
import { initDeploymentOperation, readDeployment } from './init-deployment.js'
import { NOW, clerkKit, openWorkerD1, spyD1, testId, type WorkerD1 } from './test/kit.js'
import { mintClerkToken } from '@vault/api/test/clerk'

let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(() => w.reset())

const base = { organizationName: 'Acme', email: 'Owner@X.test', agentName: 'bot', authOrgId: 'org_acme' }
const env = () => ({ now: NOW, newId: () => uuidv7(NOW) })
const all = async (table: string) => (await w.d1.prepare(`select * from "${table}"`).all()).results as Array<Record<string, unknown>>
const counts = async () =>
  Object.fromEntries(await Promise.all(['deployment', 'organizations', 'users', 'principals', 'memberships', 'agents', 'api_keys', 'events'].map(async (t) => [t, (await all(t)).length])))

describe('bootstrapD1 (P7)', () => {
  it('a fresh bootstrap writes the marker, the organisation, the owner, the agent and a key, with no events', async () => {
    const r = await bootstrapD1(w.d1, base, env())
    expect(r.deployment).toBe('created')
    const [marker] = await all('deployment')
    const [org] = await all('organizations')
    expect(marker).toMatchObject({ organization_id: r.organizationId, auth_provider: 'clerk', auth_org_id: 'org_acme' })
    expect(org).toMatchObject({ id: r.organizationId, name: 'Acme', auth_provider: 'clerk', auth_org_id: 'org_acme' })
    const [user] = await all('users')
    expect(user).toMatchObject({ id: r.userId, email: 'owner@x.test' })
    expect(await all('memberships')).toMatchObject([{ user_id: r.userId, organization_id: r.organizationId, role: 'owner' }])
    expect(await all('agents')).toMatchObject([{ id: r.agentId, organization_id: r.organizationId }])
    const [key] = await all('api_keys')
    expect(key).toMatchObject({ id: r.apiKeyId, agent_id: r.agentId })
    expect(key!.key_hash).toBe(await hashApiKey(r.key))
    expect(r.key).toMatch(/^vk_/)
    expect(await all('events')).toEqual([])
    for (const row of [org!, user!, key!]) expect(row.created_at).toBe(NOW.toISOString())
  })

  it('the key authenticates as the agent', async () => {
    const r = await bootstrapD1(w.d1, base, env())
    const binding = d1Binding(w.d1, { organizationId: r.organizationId, authProvider: 'clerk', authOrgId: 'org_acme' })
    const principal = await authenticateApiKey(binding, r.key, { now: NOW, newId: testId })
    expect(principal).toMatchObject({ actor: { id: r.agentId, kind: 'agent' }, organizationId: r.organizationId })
  })

  it('a second run is refused and writes nothing', async () => {
    const r = await bootstrapD1(w.d1, base, env())
    const before = await counts()
    await expect(bootstrapD1(w.d1, base, env())).rejects.toThrow(`organization ${r.organizationId} is already initialised`)
    expect(await counts()).toEqual(before)
  })

  it('resumes after a marker-only crash', async () => {
    const link = { organizationId: uuidv7(NOW), authProvider: 'clerk', authOrgId: 'org_acme' }
    await execute(d1Binding(w.d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
    const r = await bootstrapD1(w.d1, base, env())
    expect(r.deployment).toBe('existing')
    expect(r.organizationId).toBe(link.organizationId)
    expect((await all('organizations')).length).toBe(1)
  })

  it('refuses a conflicting link and writes nothing', async () => {
    const link = { organizationId: uuidv7(NOW), authProvider: 'clerk', authOrgId: 'org_a' }
    await execute(d1Binding(w.d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
    const before = await counts()
    await expect(bootstrapD1(w.d1, { ...base, authOrgId: 'org_b' }, env())).rejects.toThrow(`deployment is already initialised for organization ${link.organizationId} (clerk:org_a)`)
    expect(await counts()).toEqual(before)
  })

  it('a linked owner signs in with no profile fetch', async () => {
    const kit = await clerkKit()
    const r = await bootstrapD1(w.d1, { ...base, authSubject: 'user_owner' }, env())
    const worker = composeD1Worker({ DB: w.d1, ...kit.env }, { fetch: kit.fetch })
    const token = await mintClerkToken(kit.issuer, { sub: 'user_owner' })
    const res = await worker.fetch(new Request('https://w.test/meta/v1/me', { headers: { authorization: `Bearer ${token}` } }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { user: { id: string } }).user.id).toBe(r.userId)
    expect(kit.fetch.calls.filter((c) => c.url.includes('/v1/users'))).toEqual([])
  })

  it('never logs the plaintext key or its hash', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const r = await bootstrapD1(w.d1, base, env())
    const hash = await hashApiKey(r.key)
    const text = JSON.stringify(spies.flatMap((s) => s.mock.calls))
    expect(text).not.toContain(r.key)
    expect(text).not.toContain(hash)
    spies.forEach((s) => s.mockRestore())
  })
})

describe('probeBatchAtomicity (C8)', () => {
  const link = () => ({ organizationId: uuidv7(NOW), authProvider: 'none', authOrgId: 'smoked1' })
  /** The failure mode: a batch that runs statement by statement, so a later failure leaves the earlier ones written. */
  const perStatement = (real: typeof w.d1): typeof w.d1 => ({
    prepare: (q: string) => real.prepare(q),
    batch: async (stmts: Parameters<typeof w.d1.batch>[0]) => {
      const out = []
      for (const s of stmts) out.push(await s.run())
      return out
    },
  }) as typeof w.d1

  it('is atomic on Miniflare D1, leaves no marker, and bootstrap then succeeds', async () => {
    const l = link()
    expect(await probeBatchAtomicity(w.d1, l)).toBe('atomic')
    expect(await readDeployment(w.d1)).toBeNull()
    const r = await bootstrapD1(w.d1, { ...base, authProvider: l.authProvider, authOrgId: l.authOrgId, organizationId: l.organizationId }, env())
    expect(r.deployment).toBe('created')
  })

  it('is skipped when a marker exists, and writes nothing', async () => {
    await bootstrapD1(w.d1, base, env())
    const spy = spyD1(w.d1)
    spy.log.clear()
    expect(await probeBatchAtomicity(spy.d1, link())).toBe('skipped')
    expect(spy.log.statements.filter((s) => /^\s*insert/i.test(s))).toEqual([])
  })

  it('detects a non-atomic batch and the leaked marker equals the link', async () => {
    const l = link()
    expect(await probeBatchAtomicity(perStatement(w.d1), l)).toBe('not-atomic')
    expect(await readDeployment(w.d1)).toEqual(l)
  })

  it('a leaked probe row is adopted by a resumed bootstrap', async () => {
    const l = link()
    await probeBatchAtomicity(perStatement(w.d1), l)
    const r = await bootstrapD1(w.d1, { ...base, authProvider: l.authProvider, authOrgId: l.authOrgId, organizationId: l.organizationId }, env())
    expect(r.deployment).toBe('existing')
    expect(r.organizationId).toBe(l.organizationId)
    expect(await all('organizations')).toHaveLength(1)
  })
})
