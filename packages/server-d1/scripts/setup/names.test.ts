// OPS276: `setup:remote` names a new instance vb-<kind>-<env> and never renames the instance its wrangler.jsonc already records
// ([[OPS262]] D5, D6, [[CORE259]] D16, P3). Reads the fixture config, never the repo's.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execute } from '@vibase/storage'
import { d1Binding } from '@vibase/storage-d1'
import { parse } from 'jsonc-parser'
import { initDeploymentOperation } from '../../src/init-deployment.js'
import { openWorkerD1, type WorkerD1 } from '../../src/test/kit.js'
import { parseSetupArgs } from './args.js'
import { runSetup } from './run.js'
import { EXPECTED_MIGRATIONS, FIXTURE_CONFIG_PATH, SHA, isWriteCommand, makeWorld, type World, type WorldOptions } from './test/world.js'

const CONFIRM = { CONFIRM_REMOTE: '1' }
const ACME = ['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai']
const SMOKED1 = ['--env', 'smoked1', '--auth', 'none', '--api-host', 'api.smoked1.vibase.ai']
const SMOKED1_ID = '13f7fb64-d909-44e7-9ce7-cc3c753bb3bc'
const fixture = readFileSync(FIXTURE_CONFIG_PATH, 'utf8')
const ORG = '0192f0a0-0000-7000-8000-000000000001'

let db: WorkerD1
beforeAll(async () => { db = await openWorkerD1() })
afterAll(async () => { await db.dispose() })
beforeEach(async () => { await db.reset() })
const world = (o: Partial<WorldOptions> = {}): World => makeWorld({ d1: db.d1, ...o })
const seedMarker = () => execute(d1Binding(db.d1, { organizationId: ORG, authProvider: 'none', authOrgId: 'smoked1' }), { kind: 'internal', organizationId: ORG }, initDeploymentOperation({ organizationId: ORG, authProvider: 'none', authOrgId: 'smoked1' }))

describe('a new instance derives vb- names', () => {
  it('creates vb-crm-<env> and vb-bodies-<env> and writes the block with vb-<env>', async () => {
    const w = world()
    expect((await runSetup(ACME, CONFIRM, w.deps)).exitCode).toBe(0)
    expect(w.writes().map((c) => c.slice(-3).join(' '))).toEqual(['d1 create vb-crm-acme', 'bucket create vb-bodies-acme'])
    const cfg = parse(w.state.configText) as { env: Record<string, any> }
    expect(cfg.env.acme.name).toBe('vb-acme')
    expect(cfg.env.acme.d1_databases[0].database_name).toBe('vb-crm-acme')
    expect(cfg.env.acme.r2_buckets[0].bucket_name).toBe('vb-bodies-acme')
  })
  it('each override flag still wins', async () => {
    const w = world()
    expect((await runSetup([...ACME, '--worker-name', 'w1', '--d1-name', 'd1x', '--r2-name', 'r1'], CONFIRM, w.deps)).exitCode).toBe(0)
    expect(w.writes().map((c) => c.slice(-3).join(' '))).toEqual(['d1 create d1x', 'bucket create r1'])
    expect((parse(w.state.configText) as any).env.acme.name).toBe('w1')
  })
  it('parses the vb- defaults', () => {
    expect(parseSetupArgs(ACME)).toMatchObject({ workerName: 'vb-acme', d1Name: 'vb-crm-acme', r2Name: 'vb-bodies-acme' })
  })
  it.each([
    ['a derived name over 63 characters', ['--env', 'a'.repeat(58), '--auth', 'none', '--api-host', 'api.acme.vibase.ai']],
    ['a given R2 name over 63 characters', [...ACME, '--r2-name', 'a'.repeat(64)]],
    ['a given D1 name over 63 characters', [...ACME, '--d1-name', 'a'.repeat(64)]],
  ])('refuses %s before any call', async (_n, argv) => {
    const w = world()
    const o = await runSetup(argv, CONFIRM, w.deps)
    expect(o.exitCode).toBe(1)
    expect(w.logs.join('\n')).toMatch(/63/)
    expect(w.argv).toEqual([])
    expect(w.fetched).toEqual([])
  })
})

describe('recorded names win (matrix: resource kind)', () => {
  // The smoked1 block recorded with exactly one kind on its old `vault-` name and the others on vb- names.
  const recorded = (kind: 'worker' | 'd1' | 'r2') => {
    const names = { worker: kind === 'worker' ? 'vault-smoked1' : 'vb-smoked1', d1: kind === 'd1' ? 'vault-smoked1' : 'vb-crm-smoked1', r2: kind === 'r2' ? 'vault-smoked1-bodies' : 'vb-bodies-smoked1' }
    const text = fixture.replace('"name": "vault-smoked1"', `"name": "${names.worker}"`).replace('"database_name": "vault-smoked1"', `"database_name": "${names.d1}"`).replace('"bucket_name": "vault-smoked1-bodies"', `"bucket_name": "${names.r2}"`)
    return { names, text }
  }
  const cases = (['worker', 'd1', 'r2'] as const).flatMap((k) => [[k, true] as const, [k, false] as const])
  it.each(cases)('%s (dry run %s): no name flags, nothing created or written, the record unchanged', async (kind, dry) => {
    await seedMarker()
    const { names, text } = recorded(kind)
    const w = world({ configText: text, d1s: [{ uuid: SMOKED1_ID, name: names.d1 }], r2s: [names.r2], applied: [...EXPECTED_MIGRATIONS], deployedSha: SHA })
    const o = await runSetup([...SMOKED1, ...(dry ? ['--dry-run'] : [])], dry ? {} : CONFIRM, w.deps)
    expect(o.exitCode).toBe(0)
    expect(o.results.map((r) => `${r.step}:${r.status}`)).toEqual(['preflight:ok', 'config:resources:ok', 'config:write:ok', 'migrate:ok', 'bootstrap:ok', 'deploy:ok', 'verify:ok'])
    expect(w.argv.filter(isWriteCommand)).toEqual([])
    expect(w.state.configText).toBe(text)
    expect(w.state.configWrites).toBe(0)
    expect(w.state.d1s).toEqual([{ uuid: SMOKED1_ID, name: names.d1 }])
    expect(w.state.r2s).toEqual([names.r2])
  })
})

describe('P3: a name flag that disagrees with the record is refused', () => {
  it.each([
    ['--d1-name', 'other-d1', 'vault-smoked1'],
    ['--r2-name', 'other-r2', 'vault-smoked1-bodies'],
    ['--worker-name', 'other-w', 'vault-smoked1'],
  ])('%s differing refuses before any call, also with --dry-run, naming the recorded value', async (flag, value, rec) => {
    for (const extra of [[], ['--dry-run']]) {
      const w = world({ d1s: [{ uuid: SMOKED1_ID, name: 'vault-smoked1' }], r2s: ['vault-smoked1-bodies'] })
      const o = await runSetup([...SMOKED1, flag, value, ...extra], extra.length ? {} : CONFIRM, w.deps)
      expect(o.exitCode).toBe(1)
      expect(o.results).toEqual([])
      expect(w.argv).toEqual([])
      expect(w.fetched).toEqual([])
      expect(w.logs.join('\n')).toContain(rec)
      expect(w.logs.join('\n')).toContain(flag)
      expect(w.state.configWrites).toBe(0)
    }
  })
  it('a flag equal to the record runs', async () => {
    const w = world({ d1s: [{ uuid: SMOKED1_ID, name: 'vault-smoked1' }], r2s: ['vault-smoked1-bodies'] })
    const o = await runSetup([...SMOKED1, '--d1-name', 'vault-smoked1', '--r2-name', 'vault-smoked1-bodies', '--worker-name', 'vault-smoked1', '--dry-run'], {}, w.deps)
    expect(o.exitCode).toBe(0)
  })
})
