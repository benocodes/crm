import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateApiKey } from '@vibase/api'
import { insertApiKey, openControlDb, revokeApiKey } from '@vibase/storage-d1'
import { uuidv7 } from '@vibase/storage'
import { bootstrapD1, NOW, openWorkerD1, type WorkerD1, composeD1Worker } from './test/kit.js'

// [[CORE350]] group 5: the composed Worker authenticates an API key against the control plane only ([[CORE329]]), in the two-database harness (workerd's Miniflare), with the real control store.
let w: WorkerD1
let agentId: string
let orgId: string
let now = NOW
const BASE = 'https://w.test'
const SCOPES = ['webhooks:read', 'tasks:read']
const worker = () => composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '' }, { clock: () => now, newId: () => uuidv7(now) })
const get = async (wk: ReturnType<typeof worker>, key: string, headers: Record<string, string> = {}) => {
  const res = await wk.fetch(
    new Request(`${BASE}/meta/v1/webhooks`, { headers: { authorization: `Bearer ${key}`, ...headers } }),
  )
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}
const ctl = () => openControlDb(w.control)
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
async function controlKey(over: { expiresAt?: string | null; agent?: string; org?: string } = {}) {
  const { key, hash, prefix } = await generateApiKey((n) => crypto.getRandomValues(new Uint8Array(n)))
  const id = uuidv7(NOW)
  const r = await insertApiKey(ctl(), {
    id,
    auditId: uuidv7(NOW),
    actorId: agentId,
    organizationId: over.org ?? orgId,
    agentId: over.agent ?? agentId,
    keyHash: hash,
    prefix,
    expiresAt: over.expiresAt ?? null,
    now: NOW.toISOString(),
  })
  expect(r).toBe('created')
  return { key, id }
}
const ctlRow = async (id: string) =>
  (await w.control.prepare('select * from api_keys where id = ?').bind(id).first()) as any
const auditCount = async () =>
  ((await w.control.prepare('select count(*) as n from control_audit').first()) as { n: number }).n

beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  now = NOW
  const b = await bootstrapD1(
    w.d1,
    { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme', scopes: SCOPES },
    { now: NOW, newId: () => uuidv7(NOW) },
  )
  agentId = b.agentId
  orgId = b.organizationId
})

describe('API keys through the composed Worker (CORE350)', () => {
  it('accepts a control-seeded key; a key control does not hold (no CRM fallback, CORE329) and a revoked control key is the exact 401 of an unknown key', async () => {
    const wk = worker()
    const k = await controlKey()
    expect((await get(wk, k.key)).status).toBe(200)
    const unknown = await get(wk, 'vk_not-a-key-at-all')
    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual({ error: expect.objectContaining({ code: 'unauthenticated' }) })
    const revoked = await controlKey()
    await revokeApiKey(ctl(), {
      id: revoked.id,
      organizationId: orgId,
      auditId: uuidv7(NOW),
      actorId: agentId,
      now: NOW.toISOString(),
    })
    const res = await get(wk, revoked.key)
    expect(res).toEqual(unknown)
  })

  it('a revocation through the store is seen by the next request on the same warm Worker', async () => {
    const wk = worker()
    const k = await controlKey()
    expect((await get(wk, k.key)).status).toBe(200)
    expect((await get(wk, k.key)).status).toBe(200)
    await revokeApiKey(ctl(), {
      id: k.id,
      organizationId: orgId,
      auditId: uuidv7(NOW),
      actorId: agentId,
      now: NOW.toISOString(),
    })
    expect((await get(wk, k.key)).status).toBe(401)
  })

  it('a control key whose agent is in another organisation is 401', async () => {
    const k = await controlKey({ org: '0190b2c4-0000-7000-8000-0000000000ff' })
    expect((await get(worker(), k.key)).status).toBe(401)
  })

  it('a mismatched x-organization-id is 403 organization_forbidden for a control key, and a matching one passes', async () => {
    const wk = worker()
    const k = await controlKey()
    const bad = await get(wk, k.key, { 'x-organization-id': '0190b2c4-0000-7000-8000-0000000000ff' })
    expect([bad.status, bad.body.error.code]).toEqual([403, 'organization_forbidden'])
    expect((await get(wk, k.key, { 'x-organization-id': orgId })).status).toBe(200)
  })

  it('the stamp: control once inside a minute and again after it, no audit row', async () => {
    const wk = worker()
    const k = await controlKey()
    const audits = await auditCount()
    expect((await ctlRow(k.id)).last_used_at).toBeNull()
    await get(wk, k.key)
    const first = (await ctlRow(k.id)).last_used_at
    expect(first).toBe(now.toISOString())
    now = new Date(NOW.getTime() + 30_000)
    await get(wk, k.key)
    expect((await ctlRow(k.id)).last_used_at).toBe(first)
    now = new Date(NOW.getTime() + 61_000)
    await get(wk, k.key)
    expect((await ctlRow(k.id)).last_used_at).toBe(now.toISOString())
    expect(await auditCount()).toBe(audits)
  })
})
