import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execute } from '@vibase/storage'
import { d1Binding } from '@vibase/storage-d1'
import { parse } from 'jsonc-parser'
import { initDeploymentOperation, readDeployment } from '../../src/init-deployment.js'
import { openWorkerD1, type WorkerD1 } from '../../src/test/kit.js'
import { PLACEHOLDER_DATABASE_ID } from '../remote.js'
import { runSetup, type SetupOutcome } from './run.js'
import { CREDS, EXPECTED_MIGRATIONS, OLD_SHA, FIXTURE_CONFIG_PATH, SHA, isWriteCommand, makeWorld, type World, type WorldOptions } from './test/world.js'

const CONFIRM = { CONFIRM_REMOTE: '1' }
const ACME = ['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai']
const SMOKED1 = ['--env', 'smoked1', '--auth', 'none', '--api-host', 'api.smoked1.vibase.ai']
const SMOKED1_ID = '13f7fb64-d909-44e7-9ce7-cc3c753bb3bc'
const realConfig = readFileSync(FIXTURE_CONFIG_PATH, 'utf8')
const states = (o: SetupOutcome) => o.results.map((r) => `${r.step}:${r.status}`)

let db: WorkerD1
beforeAll(async () => {
  db = await openWorkerD1()
})
afterAll(async () => {
  await db.dispose()
})
beforeEach(async () => {
  await db.reset()
})

const world = (o: Partial<WorldOptions> = {}): World => makeWorld({ d1: db.d1, ...o })
const smoked1World = (o: Partial<WorldOptions> = {}): World => world({ d1s: [{ uuid: SMOKED1_ID, name: 'vault-smoked1' }], r2s: ['vault-smoked1-bodies'], applied: [...EXPECTED_MIGRATIONS], deployedSha: SHA, ...o })
const seedMarker = (authProvider: string, authOrgId: string) =>
  execute(d1Binding(db.d1, { organizationId: '0192f0a0-0000-7000-8000-000000000001', authProvider, authOrgId }), { kind: 'internal', organizationId: '0192f0a0-0000-7000-8000-000000000001' }, initDeploymentOperation({ organizationId: '0192f0a0-0000-7000-8000-000000000001', authProvider, authOrgId }))

describe('D8 guards', () => {
  it('neither CONFIRM_REMOTE nor --dry-run refuses before any subprocess, fetch or credential read', async () => {
    const w = world()
    let loaded = 0
    w.deps.loadEnv = () => (loaded++, CREDS)
    const o = await runSetup(ACME, {}, w.deps)
    expect(o.exitCode).toBe(1)
    expect(w.argv).toEqual([])
    expect(w.fetched).toEqual([])
    expect(loaded).toBe(0)
    expect(w.logs.join('\n')).toContain('CONFIRM_REMOTE=1')
  })

  it('--dry-run on an empty state issues no write command, writes no file, and plans every later step as blocked', async () => {
    const w = world()
    const o = await runSetup([...ACME, '--dry-run'], {}, w.deps)
    expect(o.exitCode).toBe(0)
    expect(w.writes()).toEqual([])
    expect(w.state.configWrites).toBe(0)
    expect(w.state.configText).toBe(realConfig)
    expect(states(o)).toEqual(['preflight:ok', 'config:resources:create', 'config:write:update', 'migrate:blocked', 'bootstrap:blocked', 'deploy:blocked', 'verify:blocked'])
  })

  it('--dry-run with CONFIRM_REMOTE set is still read-only', async () => {
    const w = world()
    await runSetup([...ACME, '--dry-run'], CONFIRM, w.deps)
    expect(w.writes()).toEqual([])
    expect(w.state.d1s).toEqual([])
  })
})

describe('empty state: the first real run (rule 3, D10)', () => {
  it('creates the D1 and the R2 bucket in order, fills the placeholder with the created id, writes the block and stops with exit 0', async () => {
    const w = world()
    const o = await runSetup(ACME, CONFIRM, w.deps)
    expect(o.exitCode).toBe(0)
    expect(o.stoppedAfterConfigWrite).toBe(true)
    expect(states(o)).toEqual(['preflight:ok', 'config:resources:create', 'config:write:update'])
    expect(w.writes().map((c) => c.slice(-3).join(' '))).toEqual(['d1 create vb-crm-acme', 'bucket create vb-bodies-acme'])
    const created = w.state.d1s.find((d) => d.name === 'vb-crm-acme')!
    const cfg = parse(w.state.configText) as { env: Record<string, { d1_databases: { database_id: string }[] }> }
    expect(cfg.env.acme!.d1_databases[0]!.database_id).toBe(created.uuid)
    expect(cfg.env.acme!.d1_databases[0]!.database_id).not.toBe(PLACEHOLDER_DATABASE_ID)
    expect(w.state.configWrites).toBe(1)
    expect(w.logs.join('\n')).toMatch(/review and commit/)
    expect(w.argv.some((c) => c.includes('apply') || c.includes('deploy'))).toBe(false)
  })
})

describe('idempotence', () => {
  it('a second and third run against the state the first left issue no write and report every step ok', async () => {
    const w = world()
    expect((await runSetup(ACME, CONFIRM, w.deps)).stoppedAfterConfigWrite).toBe(true)
    const second = await runSetup(ACME, CONFIRM, w.deps)
    expect(second.exitCode).toBe(0)
    expect(states(second)).toEqual(['preflight:ok', 'config:resources:ok', 'config:write:ok', 'migrate:update', 'bootstrap:create', 'deploy:update', 'verify:ok'])
    expect(w.state.deployedSha).toBe(SHA)
    expect(await readDeployment(db.d1)).toMatchObject({ authProvider: 'none', authOrgId: 'acme' })

    const before = w.argv.length
    const configBefore = w.state.configText
    const third = await runSetup(ACME, CONFIRM, w.deps)
    expect(third.exitCode).toBe(0)
    expect(states(third)).toEqual(['preflight:ok', 'config:resources:ok', 'config:write:ok', 'migrate:ok', 'bootstrap:ok', 'deploy:ok', 'verify:ok'])
    expect(w.argv.slice(before).filter(isWriteCommand)).toEqual([])
    expect(w.state.configText).toBe(configBefore)
  })
})

describe('smoked1 plans no change (--auth none)', () => {
  it('the repo wrangler.jsonc with state matching it: every step ok, file untouched, no write command', async () => {
    await seedMarker('none', 'smoked1')
    const w = smoked1World()
    const o = await runSetup([...SMOKED1, '--dry-run'], {}, w.deps)
    expect(o.exitCode).toBe(0)
    expect(states(o)).toEqual(['preflight:ok', 'config:resources:ok', 'config:write:ok', 'migrate:ok', 'bootstrap:ok', 'deploy:ok', 'verify:ok'])
    expect(w.state.configText).toBe(realConfig)
    expect(w.writes()).toEqual([])
  })
})

describe('D9 refusal: a differing present value fails naming the key and stops the run', () => {
  const cases: [string, string, string[], RegExp][] = [
    ['resource id', realConfig.replace(SMOKED1_ID, '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'), SMOKED1, /database_id/],
    // The Worker, D1 and R2 names are the record itself now ([[OPS276]]): drift is shown on another key.
    ['workers_dev', realConfig.replace('"workers_dev": false', '"workers_dev": true'), SMOKED1, /smoked1\.workers_dev/],
    ['var', realConfig, [...SMOKED1, '--web-origin', 'https://app.example.com'], /CORS_ALLOWED_ORIGINS/],
  ]
  it.each(cases)('%s', async (_n, configText, args, key) => {
    const w = smoked1World({ configText })
    const o = await runSetup(args, CONFIRM, w.deps)
    expect(o.exitCode).toBe(1)
    expect(states(o)).toEqual(['preflight:ok', 'config:resources:ok', 'config:write:fail'])
    expect(o.results.at(-1)!.detail).toMatch(key)
    expect(w.state.configText).toBe(configText)
    expect(w.state.configWrites).toBe(0)
    expect(w.writes()).toEqual([])
  })
})

describe('D23 preflight', () => {
  it('a read probe the token cannot make fails naming the permission, creates nothing and stops', async () => {
    const w = world({ denied: ['r2'] })
    const o = await runSetup(ACME, CONFIRM, w.deps)
    expect(o.exitCode).toBe(1)
    expect(states(o)).toEqual(['preflight:fail'])
    expect(o.results[0]!.detail + (o.results[0]!.lines ?? []).join('\n')).toMatch(/R2/)
    expect(w.writes()).toEqual([])
    expect(w.argv).toEqual([])
  })
  it('a zone the token cannot see fails naming the api host', async () => {
    const w = world({ zones: ['other.example'] })
    const o = await runSetup(ACME, CONFIRM, w.deps)
    expect(states(o)).toEqual(['preflight:fail'])
    expect(o.results[0]!.detail + (o.results[0]!.lines ?? []).join('\n')).toContain('api.acme.vibase.ai')
    expect(w.writes()).toEqual([])
  })
})

describe('order and --only (D11, D6)', () => {
  it('runs the steps in the D11 order', async () => {
    await seedMarker('none', 'smoked1')
    const o = await runSetup([...SMOKED1, '--dry-run'], {}, smoked1World().deps)
    expect(o.results.map((r) => r.step)).toEqual(['preflight', 'config:resources', 'config:write', 'migrate', 'bootstrap', 'deploy', 'verify'])
  })
  it('--only runs exactly those steps, in D11 order whatever order they were given', async () => {
    await seedMarker('none', 'smoked1')
    const w = smoked1World()
    const o = await runSetup([...SMOKED1, '--only', 'verify,migrate', '--dry-run'], {}, w.deps)
    expect(states(o)).toEqual(['migrate:ok', 'verify:ok'])
  })
  it('an unknown step name is refused before any network call', async () => {
    const w = world()
    const o = await runSetup([...ACME, '--only', 'nope', '--dry-run'], {}, w.deps)
    expect(o.exitCode).toBe(1)
    expect(w.argv).toEqual([])
    expect(w.fetched).toEqual([])
  })
})

describe('migrate', () => {
  it('behind: applies, then reports update; current: ok with no apply', async () => {
    const w = smoked1World({ applied: EXPECTED_MIGRATIONS.slice(0, 3) })
    const o = await runSetup([...SMOKED1, '--only', 'migrate'], CONFIRM, w.deps)
    expect(states(o)).toEqual(['migrate:update'])
    expect(w.writes().length).toBe(1)
    expect(w.state.applied).toEqual(EXPECTED_MIGRATIONS)
  })
})

describe('deploy idempotence', () => {
  it('/health already at the sha deploy:remote would stamp: ok, no deploy command', async () => {
    const w = smoked1World({ deployedSha: SHA })
    const o = await runSetup([...SMOKED1, '--only', 'deploy'], CONFIRM, w.deps)
    expect(states(o)).toEqual(['deploy:ok'])
    expect(w.argv.some((c) => c.includes('deploy'))).toBe(false)
  })
  it('a different sha: deploy is issued with --var VERSION:<full head sha>', async () => {
    const w = smoked1World({ deployedSha: OLD_SHA })
    const o = await runSetup([...SMOKED1, '--only', 'deploy'], CONFIRM, w.deps)
    expect(states(o)).toEqual(['deploy:update'])
    const dep = w.argv.find((c) => c.includes('deploy'))!
    expect(dep).toEqual(expect.arrayContaining(['wrangler', 'deploy', '--env', 'smoked1', '--var', `VERSION:${SHA}`]))
    expect(w.state.deployedSha).toBe(SHA)
  })
  it('a dirty tree is a fail with no deploy command (deploy:remote refuses it, OPS4 D12)', async () => {
    const w = smoked1World({ deployedSha: OLD_SHA, dirty: true })
    const o = await runSetup([...SMOKED1, '--only', 'deploy'], CONFIRM, w.deps)
    expect(states(o)).toEqual(['deploy:fail'])
    expect(w.argv.some((c) => c.includes('deploy'))).toBe(false)
  })
  it('a dry run reports the deploy it would make and issues none', async () => {
    const w = smoked1World({ deployedSha: OLD_SHA })
    const o = await runSetup([...SMOKED1, '--only', 'deploy', '--dry-run'], {}, w.deps)
    expect(states(o)).toEqual(['deploy:update'])
    expect(w.writes()).toEqual([])
  })
})

describe('verify bound (D21)', () => {
  it('/health never current: fail after the bound, without real waiting', async () => {
    const w = smoked1World({ healthNeverCurrent: true })
    const o = await runSetup([...SMOKED1, '--only', 'verify'], CONFIRM, w.deps)
    expect(o.exitCode).toBe(1)
    expect(states(o)).toEqual(['verify:fail'])
    expect(w.state.sleeps.length).toBeGreaterThan(1)
    expect(w.state.sleeps.length).toBeLessThan(100)
    expect(w.fetched.filter((u) => u.endsWith('/health')).length).toBe(w.state.sleeps.length + 1)
  })
  it('a Worker that is not answering yet is polled until it does', async () => {
    const w = smoked1World({ deployedSha: null })
    let calls = 0
    const real = w.deps.fetch
    w.deps.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).endsWith('/health') && ++calls === 3) w.state.deployedSha = SHA
      return real(i, init)
    }) as typeof fetch
    const o = await runSetup([...SMOKED1, '--only', 'verify'], CONFIRM, w.deps)
    expect(states(o)).toEqual(['verify:ok'])
    expect(calls).toBe(3)
  })
})

describe('D18 bootstrap marker', () => {
  const only = [...SMOKED1, '--only', 'bootstrap']
  it('the same marker is ok and writes nothing', async () => {
    await seedMarker('none', 'smoked1')
    const w = smoked1World()
    expect(states(await runSetup(only, CONFIRM, w.deps))).toEqual(['bootstrap:ok'])
    expect(await readDeployment(db.d1)).toMatchObject({ authProvider: 'none', authOrgId: 'smoked1' })
  })
  it('a matching marker with operator flags: ok, says the flags were not applied, .env unchanged, no log line claims the key', async () => {
    await seedMarker('none', 'smoked1')
    const w = smoked1World()
    const o = await runSetup([...SMOKED1, '--only', 'bootstrap,verify', '--operator-agent', 'operator', '--key-env', 'SMOKED1_KEY', '--owner-email', 'owner@example.com'], CONFIRM, w.deps)
    expect(states(o)).toEqual(['bootstrap:ok', 'verify:ok'])
    expect(o.results[0]!.detail).toMatch(/not applied/)
    expect(w.state.envText).toBe('')
    expect(w.logs.join('\n')).not.toMatch(/operator key in \.env/)
  })
  it('verify without a key prints the exact repair command', async () => {
    const w = smoked1World()
    const o = await runSetup([...SMOKED1, '--only', 'verify'], CONFIRM, w.deps)
    expect((o.results[0]!.lines ?? []).join('\n')).toContain('CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env smoked1 --key-env <NAME> --org <name> --auth-provider none --auth-org-id smoked1 --email <email> --agent <name>')
  })
  it('a different marker is a fail and writes nothing', async () => {
    await seedMarker('none', 'other')
    const w = smoked1World()
    const o = await runSetup(only, CONFIRM, w.deps)
    expect(states(o)).toEqual(['bootstrap:fail'])
    expect(o.results[0]!.detail).toContain('other')
    expect(await readDeployment(db.d1)).toMatchObject({ authOrgId: 'other' })
  })
  it('an absent marker is bootstrapped: the none:<env> marker lands in D1', async () => {
    const w = smoked1World()
    expect(states(await runSetup(only, CONFIRM, w.deps))).toEqual(['bootstrap:create'])
    expect(await readDeployment(db.d1)).toMatchObject({ authProvider: 'none', authOrgId: 'smoked1' })
    expect(w.state.envText).toBe('')
  })
  it('a dry run only reports the bootstrap it would make', async () => {
    const w = smoked1World()
    expect(states(await runSetup([...only, '--dry-run'], {}, w.deps))).toEqual(['bootstrap:create'])
    expect(await readDeployment(db.d1)).toBeNull()
  })
  it('with the operator flags the key goes to .env and nowhere else', async () => {
    const w = smoked1World()
    const o = await runSetup([...only, '--operator-agent', 'operator', '--key-env', 'SMOKED1_KEY', '--owner-email', 'owner@example.com'], CONFIRM, w.deps)
    expect(states(o)).toEqual(['bootstrap:create'])
    const m = /^SMOKED1_KEY=(.+)$/m.exec(w.state.envText)
    expect(m).not.toBeNull()
    const key = m![1]!
    expect(key.length).toBeGreaterThan(16)
    expect(w.surface()).not.toContain(key)
  })
  it('a key variable already in .env is refused before anything is written', async () => {
    const w = smoked1World({ envText: 'SMOKED1_KEY=vk_existing\n' })
    const o = await runSetup([...only, '--operator-agent', 'operator', '--key-env', 'SMOKED1_KEY', '--owner-email', 'owner@example.com'], CONFIRM, w.deps)
    expect(states(o)).toEqual(['bootstrap:fail'])
    expect(await readDeployment(db.d1)).toBeNull()
  })
})

describe('no secret leaks across a full run', () => {
  it('neither the operator key nor any credential reaches an argv, stdin, a fetched url or a log line', async () => {
    const w = world()
    const args = [...ACME, '--operator-agent', 'operator', '--key-env', 'ACME_KEY', '--owner-email', 'owner@example.com']
    await runSetup(args, CONFIRM, w.deps)
    await runSetup(args, CONFIRM, w.deps)
    const key = /^ACME_KEY=(.+)$/m.exec(w.state.envText)?.[1]
    expect(key).toBeTruthy()
    const surface = w.surface()
    expect(surface).not.toContain(key!)
    expect(surface).not.toContain(CREDS.apiToken)
    expect(surface).not.toContain(CREDS.accountId)
    expect(w.fetched.join('\n')).not.toContain(key!)
    expect(w.fetched.join('\n')).not.toContain(CREDS.apiToken)
    expect(w.state.configText).not.toContain(key!)
    expect(w.state.configText).not.toContain(CREDS.apiToken)
  })
})
