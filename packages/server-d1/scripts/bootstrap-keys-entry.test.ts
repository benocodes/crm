// [[CORE356]] group 3: the `bootstrap` script's entry points mint the operator key on the control plane. The local mode runs through the REAL wrangler.jsonc bindings (`getPlatformProxy`, the CORE259 lesson); `--remote`
// through its existing fake proxy (`runBootstrap`). The two setup front-ends are proved in their own suites (`setup/clerk.test.ts`, `setup/better-auth.test.ts`, `instance/setup.test.ts`, `instance/setup-better-auth.test.ts`).
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import type { D1Like } from '@vibase/storage-d1'
import { applyControlMigrations, applyMigrations } from '@vibase/storage-d1/test'
import { openWorkerPair, type WorkerPair } from '../src/test/kit.js'
import { runBootstrap, type BootstrapIo } from './bootstrap.js'
import type { Target } from './remote.js'

const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const count = async (db: D1Like, table: string) =>
  ((await db.prepare(`select count(*) as n from ${table}`).first()) as { n: number }).n

function io(): BootstrapIo & { logs: string[]; errors: string[]; env: { text: string } } {
  const state = { text: '' }
  const logs: string[] = []
  const errors: string[] = []
  return {
    logs,
    errors,
    env: state,
    log: (l) => void logs.push(l),
    error: (l) => void errors.push(l),
    readEnvText: () => state.text,
    writeEnvText: (t) => void (state.text = t),
  }
}

describe('bootstrap local, through the real wrangler.jsonc bindings', () => {
  it.each([
    ['none', { 'auth-provider': 'none', 'auth-org-id': 'demo', email: 'owner@example.com' }],
    ['clerk', { issuer: 'https://clerk.test.example' }],
  ] as const)(
    '%s: the key is in CONTROL_DB with its audit row and DB has none',
    async (_n, extra) => {
      const dir = mkdtempSync(join(tmpdir(), 'wrangler-keys-'))
      const proxy = await getPlatformProxy<{ DB: D1Like; CONTROL_DB: D1Like }>({
        configPath: CONFIG,
        persist: { path: dir },
        remoteBindings: false,
      })
      try {
        await applyMigrations(proxy.env.DB)
        await applyControlMigrations(proxy.env.CONTROL_DB)
        const i = io()
        const authOrgId = 'issuer' in extra ? extra.issuer : 'demo'
        expect(
          await runBootstrap({ mode: 'local', values: { org: 'Local', agent: 'op', ...extra }, authOrgId }, proxy, i),
          i.errors.join('\n'),
        ).toBe(0)
        expect(await count(proxy.env.DB, 'api_keys')).toBe(0)
        expect(await count(proxy.env.CONTROL_DB, 'api_keys')).toBe(1)
        expect(await count(proxy.env.CONTROL_DB, 'control_audit')).toBe(1)
        const printed = i.logs.find((l) => l.startsWith('api_key:'))
        expect(printed).toMatch(/vk_/)
      } finally {
        await proxy.dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})

describe('bootstrap --remote through its fake proxy', () => {
  let pair: WorkerPair
  beforeAll(async () => {
    pair = await openWorkerPair()
  }, 60_000)
  afterAll(() => pair.dispose())
  afterEach(() => pair.reset())
  const target: Target = {
    env: 'demo',
    workerName: 'vb-demo',
    databaseName: 'vb-crm-demo',
    databaseId: '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b',
    control: { databaseName: 'vb-control-demo', databaseId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' },
  }
  const run = (i: BootstrapIo, control: D1Like = pair.control) =>
    runBootstrap(
      {
        mode: 'remote',
        keyEnv: 'OP_KEY',
        values: {
          org: 'demo',
          agent: 'op',
          email: 'owner@example.com',
          'auth-provider': 'none',
          'auth-org-id': 'demo',
        },
        authOrgId: 'demo',
        target,
      },
      { env: { DB: pair.d1, CONTROL_DB: control } },
      i,
    )

  it('writes the key to .env, the key and its audit row to control and none to the CRM', async () => {
    const i = io()
    expect(await run(i), i.errors.join('\n')).toBe(0)
    expect(i.env.text).toMatch(/^OP_KEY=vk_\S+$/m)
    expect(await count(pair.d1, 'api_keys')).toBe(0)
    expect(await count(pair.control, 'api_keys')).toBe(1)
    expect(await count(pair.control, 'control_audit')).toBe(1)
    expect(i.logs.join('\n')).not.toContain(/^OP_KEY=(\S+)$/m.exec(i.env.text)![1]!)
  })

  it("a lost .env write names the key's control id and the revoke recovery", async () => {
    const i = io()
    i.writeEnvText = () => {
      throw Object.assign(new Error('disk'), { code: 'EACCES' })
    }
    expect(await run(i)).toBe(1)
    const [id] = ((await pair.control.prepare('select id from api_keys').all()).results ?? []) as { id: string }[]
    expect(i.errors.join('\n')).toContain(`control api key ${id!.id}`)
  })
})
