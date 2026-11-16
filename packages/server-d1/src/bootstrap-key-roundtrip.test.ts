import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { mintClerkToken } from '@vibase/api/test/clerk'
import {
  NOW,
  bootstrapD1,
  clerkKit,
  clerkUser,
  composeD1Worker,
  openWorkerD1,
  type ClerkKit,
  type WorkerD1,
} from './test/kit.js'

// [[CORE356]] group 4: a key minted by `bootstrapD1` (the Clerk path, an operator agent) is a control key end to end on the composed Worker: it authenticates, `api_keys.list` shows it, `audit.list` shows its
// `api_key.created` row, and after `api_keys.revoke` it is refused on the same warm Worker.
let w: WorkerD1
let kit: ClerkKit
let clock = new Date()
beforeAll(async () => {
  w = await openWorkerD1()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  kit.fetch.reset()
  kit.profiles.clear()
  clock = new Date()
})

const BASE = 'https://w.test'
const worker = () =>
  composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined } as never, {
    fetch: kit.fetch,
    clock: () => clock,
  })
const owner = () => {
  kit.profiles.set('user_owner', clerkUser({ id: 'user_owner', email: 'o@x.test', verified: true, role: 'owner' }))
  return mintClerkToken(kit.issuer, { sub: 'user_owner', extra: { vibase_role: 'owner' }, now: clock })
}
async function rest(wk: ReturnType<typeof worker>, method: string, path: string, token: string) {
  const res = await wk.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${token}` } }))
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

describe('a bootstrap key through the composed Worker (CORE356 group 4)', () => {
  it('authenticates, is listed, has its audit row, and is refused after revoke on the same warm Worker', async () => {
    const r = await bootstrapD1(
      w.d1,
      { organizationName: 'Acme', agentName: 'bot', authOrgId: kit.issuer.issuer, scopes: ['tasks:read'] },
      { now: NOW, newId: () => uuidv7(NOW) },
    )
    const wk = worker()
    const tok = await owner()
    expect((await rest(wk, 'GET', '/meta/v1/me', r.key)).status).toBe(200)
    const list = await rest(wk, 'GET', '/meta/v1/api-keys', tok)
    expect(list.json.data.map((k: any) => k.id)).toEqual([r.apiKeyId])
    const audit = await rest(wk, 'GET', '/meta/v1/audit', tok)
    expect(audit.status).toBe(200)
    expect(audit.json.data.filter((a: any) => a.action === 'api_key.created').map((a: any) => a.target_id)).toEqual([
      r.apiKeyId,
    ])
    expect((await rest(wk, 'POST', `/meta/v1/api-keys/${r.apiKeyId}/revoke`, tok)).status).toBe(200)
    expect((await rest(wk, 'GET', '/meta/v1/me', r.key)).status).toBe(401)
  })
})
