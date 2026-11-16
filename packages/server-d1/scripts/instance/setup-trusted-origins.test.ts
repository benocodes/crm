// UI255 D6 (group 5) on `vibase-server setup`: `AUTH_TRUSTED_ORIGINS` is an operator-owned var in the settings record. A re-run keeps it; a fresh instance records nothing for it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { ALL_MIGRATIONS, API_HOST, setupWorld, type SetupWorld, type SetupWorldOptions } from './setup-kit.js'
import { runSetup } from './setup.js'
import { CONTROL_ALL, CONTROL_UUID, SECRETS_TEXT, UUID, cleanup, controlSettings } from './test-kit.js'

const BASE = `https://${API_HOST}`
const ARGS = ['--env', 'demo', '--api-host', API_HOST, '--owner-email', 'owner@example.com']
const TRUSTED = 'https://app.example.com'

let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(() => pair.dispose())
beforeEach(() => pair.reset())
afterEach(() => cleanup())

const world = (o: Partial<SetupWorldOptions> = {}): SetupWorld => setupWorld({ d1: pair, control: pair.control, ...o })
const recordedWith = (vars: Record<string, string>) => ({
  settings: controlSettings({ vars }),
  secretsText: SECRETS_TEXT,
  sim: {
    d1s: [
      { uuid: UUID, name: 'vault-demo' },
      { uuid: CONTROL_UUID, name: 'ctl-recorded-name' },
    ],
    r2s: ['vault-demo-bodies'],
    applied: [...ALL_MIGRATIONS],
    controlApplied: [...CONTROL_ALL],
    deployed: { version: 'v', commit: 'c' },
  },
})

describe('setup and AUTH_TRUSTED_ORIGINS', () => {
  it('a re-run over a settings record that holds it keeps it unchanged (config:write ok)', async () => {
    const s = world(
      recordedWith({
        AUTH_PROVIDER: 'better-auth',
        PUBLIC_BASE_URL: BASE,
        CORS_ALLOWED_ORIGINS: '',
        AUTH_TRUSTED_ORIGINS: TRUSTED,
      }),
    )
    expect(await runSetup(ARGS, s.w.deps), s.w.all()).toBe(0)
    expect(s.rows().find((r) => r.step === 'config:write')!.status).toBe('ok')
    expect(JSON.parse(s.settings()!).vars.AUTH_TRUSTED_ORIGINS).toBe(TRUSTED)
    expect(s.w.all()).not.toMatch(/AUTH_TRUSTED_ORIGINS/)
  })

  it('a fresh instance records nothing for it', async () => {
    const s = world()
    await runSetup(ARGS, s.w.deps)
    expect(JSON.parse(s.settings()!).vars).not.toHaveProperty('AUTH_TRUSTED_ORIGINS')
    expect(s.w.all()).not.toMatch(/AUTH_TRUSTED_ORIGINS/)
  })
})
