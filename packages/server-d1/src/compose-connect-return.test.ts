import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { type D1WorkerEnv } from './compose.js'
import { bootstrapD1, NOW, openWorkerD1, type WorkerD1, composeD1Worker } from './test/kit.js'

// [[UI469]] D5 (group 2) / [[UI458]] D5: the composed Worker passes the `/accounts` default return path to the Gmail callback only when the app is served (`ASSETS` bound).
// The callback answers a refusal with no state; a set CONNECT_RETURN_URL always wins.
const GMAIL_ENV = {
  GOOGLE_CLIENT_ID: 'fake-client-id.apps.test',
  GOOGLE_CLIENT_SECRET: 'fake-client-secret',
  OAUTH_STATE_SECRET: 'state-secret',
  CREDENTIALS_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
}
const BASE = 'https://w.test'
const SET = 'https://elsewhere.example.test/done'
const ASSETS = { fetch: async () => new Response('Not found', { status: 404 }) }

let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
}, 30_000)
afterAll(() => w?.dispose())
beforeEach(async () => {
  await w.reset()
  await bootstrapD1(
    w.d1,
    { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme' },
    { now: NOW, newId: () => uuidv7(NOW) },
  )
})

const callback = (extra: Partial<D1WorkerEnv>) =>
  composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '', PUBLIC_BASE_URL: BASE, ...GMAIL_ENV, ...extra }).fetch(
    new Request(`${BASE}/oauth/callback/google`),
  )

describe('the callback default return path follows ASSETS (D5)', () => {
  it('with ASSETS bound and CONNECT_RETURN_URL unset: 302 to the instance /app/accounts', async () => {
    const res = await callback({ ASSETS })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${BASE}/app/accounts?error=state_invalid`)
  })
  it('without ASSETS: the built-in result page', async () => {
    const res = await callback({})
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toContain('state_invalid')
  })
  it('with CONNECT_RETURN_URL set, that URL with or without ASSETS', async () => {
    for (const extra of [{ ASSETS }, {}]) {
      const res = await callback({ CONNECT_RETURN_URL: SET, ...extra })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(`${SET}?error=state_invalid`)
    }
  })
})
