// OPS276: `vibase-server setup` names a new instance vb-<kind>-<env> and never renames a recorded one ([[OPS262]] D5, D6, [[CORE259]] D16, P3).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openWorkerD1, type WorkerD1 } from '../../src/test/kit.js'
import { parseInstanceSetupArgs } from './setup-args.js'
import { ALL_MIGRATIONS, API_HOST, NONE_ARGS, setupWorld, type SetupWorld, type SetupWorldOptions } from './setup-kit.js'
import { runSetup } from './setup.js'
import { CONTROL_ALL, CONTROL_UUID, cleanup, UUID, validSettings } from './test-kit.js'

let d1: WorkerD1
beforeAll(async () => { d1 = await openWorkerD1() }, 60_000)
afterAll(async () => { await d1.dispose() })
afterEach(async () => { cleanup(); await d1.reset() })

const world = (o: Partial<SetupWorldOptions> = {}): SetupWorld => setupWorld({ d1, ...o })
const run = (s: SetupWorld, argv: string[] = NONE_ARGS) => runSetup(argv, s.w.deps)
const configsOf = (s: SetupWorld) => s.w.wrangler.flatMap((c) => (c.configText ? [JSON.parse(c.configText) as Record<string, any>] : []))
const MARKER = { organization_id: 'org-1', auth_provider: 'none', auth_org_id: 'demo', organizations: 1 }

describe('a new instance derives vb- names', () => {
  it('creates vb-crm-<env> and vb-bodies-<env>, and records worker vb-<env> and workflow vb-mail-sync-<env>', async () => {
    const s = world({})
    expect(await run(s)).toBe(0)
    expect(s.writes().slice(0, 3).map((a) => a.slice(0, 4).join(' '))).toEqual(['d1 create vb-crm-demo', 'd1 create vb-control-demo', 'r2 bucket create vb-bodies-demo'])
    const saved = JSON.parse(s.settings()!)
    expect(saved).toMatchObject({ worker: 'vb-demo', d1: { name: 'vb-crm-demo' }, r2_bucket: 'vb-bodies-demo', workflow: { name: 'vb-mail-sync-demo' } })
    for (const c of configsOf(s)) expect(JSON.stringify(c)).not.toContain('vault')
  })
  it('--worker-name, --d1-name and --r2-name still win on a new instance', async () => {
    const s = world({})
    expect(await run(s, [...NONE_ARGS, '--worker-name', 'w1', '--d1-name', 'd1x', '--r2-name', 'r1'])).toBe(0)
    expect(s.writes().slice(0, 3).map((a) => a.slice(0, 4).join(' '))).toEqual(['d1 create d1x', 'd1 create vb-control-demo', 'r2 bucket create r1'])
    expect(JSON.parse(s.settings()!)).toMatchObject({ worker: 'w1', d1: { name: 'd1x' }, r2_bucket: 'r1' })
  })
  it('parses the vb- defaults', () => {
    expect(parseInstanceSetupArgs(NONE_ARGS).opts).toMatchObject({ workerName: 'vb-demo', d1Name: 'vb-crm-demo', r2Name: 'vb-bodies-demo' })
  })
  const long = (n: number) => 'a'.repeat(n)
  it.each([
    ['a derived name over 63 characters', ['--env', long(58), '--api-host', API_HOST, '--auth', 'none']],
    ['a given D1 name over 63 characters', [...NONE_ARGS, '--d1-name', long(64)]],
    ['a given worker name over 63 characters', [...NONE_ARGS, '--worker-name', long(64)]],
    ['a derived workflow name over 63 characters (env of 51)', ['--env', long(51), '--api-host', API_HOST, '--auth', 'none']],
  ])('refuses %s before any call', async (_n, argv) => {
    const s = world({})
    expect(await run(s, argv)).toBe(2)
    expect(s.w.err.join('\n')).toMatch(/63/)
    expect(s.w.wrangler).toHaveLength(0)
    expect(s.w.fetchUrls).toEqual([])
  })
  it('accepts names of exactly 63 characters', () => {
    expect(() => parseInstanceSetupArgs([...NONE_ARGS, '--d1-name', long(63)])).not.toThrow()
  })
})

describe('recorded names win (matrix: resource kind)', () => {
  const VB = { worker: 'vb-demo', d1: 'vb-crm-demo', r2: 'vb-bodies-demo', workflow: 'vb-mail-sync-demo' }
  const LEGACY = { worker: 'vault-demo', d1: 'vault-demo', r2: 'vault-demo-bodies', workflow: 'vault-demo-mail-sync' }
  // A record that differs from the derivation in exactly one kind, so a kind left on the derivation turns its own case red.
  const cases = (['worker', 'd1', 'r2', 'workflow'] as const).map((kind) => {
    const n = { ...VB, [kind]: LEGACY[kind] }
    return [kind, n] as const
  })
  it.each(cases)('%s: a re-run with no name flags creates nothing, keeps the record and targets the recorded names', async (kind, n) => {
    const settings = validSettings({ worker: n.worker, d1: { name: n.d1, id: UUID }, r2_bucket: n.r2, workflow: { name: n.workflow }, vars: { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' }, control_d1: { name: 'vb-control-demo', id: CONTROL_UUID } })
    const s = world({ controlMarker: 'org-1', settings, sim: { d1s: [{ uuid: UUID, name: n.d1 }, { uuid: CONTROL_UUID, name: 'vb-control-demo' }], r2s: [n.r2], applied: [...ALL_MIGRATIONS], controlApplied: [...CONTROL_ALL], marker: MARKER, deployed: { version: 'a'.repeat(40), commit: null } } })
    const before = s.settings()
    expect(await run(s)).toBe(0)
    expect(s.w.err).toEqual([])
    expect(s.settings()).toBe(before)
    expect(s.writes().map((a) => a.slice(0, 3).join(' ')).filter((v) => v.startsWith('d1 create') || v.startsWith('r2 bucket create'))).toEqual([])
    const cfgs = configsOf(s)
    expect(cfgs.length).toBeGreaterThan(0)
    for (const c of cfgs) {
      expect(c.name).toBe(n.worker)
      expect(c.d1_databases[0].database_name).toBe(n.d1)
      expect(c.r2_buckets?.[0]?.bucket_name ?? n.r2).toBe(n.r2)
      expect(c.workflows?.[0]?.name ?? n.workflow).toBe(n.workflow)
    }
    expect(kind).toBeTruthy()
  })
})

describe('P3: a name flag that disagrees with the record is refused', () => {
  const recorded = () => world({ settings: validSettings(), sim: { d1s: [{ uuid: UUID, name: 'vault-demo' }], r2s: ['vault-demo-bodies'], applied: [...ALL_MIGRATIONS], marker: MARKER, deployed: { version: 'a'.repeat(40), commit: null } } })
  it.each([
    ['--d1-name', 'other-d1', 'vault-demo'],
    ['--r2-name', 'other-r2', 'vault-demo-bodies'],
    ['--worker-name', 'other-w', 'vault-demo'],
  ])('%s differing exits 2 before any call, also with --dry-run, naming the recorded value', async (flag, value, rec) => {
    for (const extra of [[], ['--dry-run']]) {
      const s = recorded()
      const before = s.settings()
      expect(await run(s, [...NONE_ARGS, flag, value, ...extra])).toBe(2)
      expect(s.w.err.join('\n')).toContain(rec)
      expect(s.w.err.join('\n')).toContain(flag)
      expect(s.w.wrangler).toHaveLength(0)
      expect(s.settings()).toBe(before)
    }
  })
  it('a flag equal to the record runs', async () => {
    const s = recorded()
    expect(await run(s, [...NONE_ARGS, '--d1-name', 'vault-demo', '--r2-name', 'vault-demo-bodies', '--worker-name', 'vault-demo'])).toBe(0)
    expect(s.w.err).toEqual([])
  })
})
