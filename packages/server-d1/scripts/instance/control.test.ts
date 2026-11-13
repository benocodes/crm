// OPS275: the instance tooling for both databases: `status` per database (the matrix), the gate's control refusals, and `upgrade`'s order and failures.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { controlNotConfigured } from '../remote.js'
import { runStatus } from './status.js'
import { runUpgrade } from './upgrade.js'
import { bindingOf, CONTROL_ALL, captureHealthBody, cleanup, controlSettings, makeWorld, NO_TRACKER_JSON, trackerJson, validSettings, type World, type WorldOptions } from './test-kit.js'
import type { RunResult } from './types.js'

afterEach(cleanup)
let HEALTH: Record<string, any>
beforeAll(async () => { HEALTH = await captureHealthBody() }, 60_000)

const CRM_ALL = ['0001_a.sql', '0002_b.sql']
type Tracker = string[] | 'none'
const answer = (t: Tracker): RunResult => (t === 'none' ? { status: 1, stdout: NO_TRACKER_JSON, stderr: '' } : { status: 0, stdout: trackerJson(t), stderr: '' })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const writes = (w: World) => w.wrangler.filter((c) => c.args[0] !== 'd1' || c.args[1] !== 'execute')

describe('OPS275 status per database (the matrix)', () => {
  const run = async (control: Tracker | 'absent', crm: Tracker, version = '0.1.0') => {
    const w = makeWorld({
      settings: control === 'absent' ? validSettings() : controlSettings(),
      health: () => json(200, { ...HEALTH, version }),
      runner: (args) => answer(bindingOf(args) === 'CONTROL_DB' ? (control as Tracker) : crm),
    })
    return { w, code: await runStatus(['--env', 'demo'], w.deps) }
  }
  const matrix: [Tracker | 'absent', Tracker, number][] = [
    ['absent', CRM_ALL, 0],
    ['absent', ['0001_a.sql'], 1],
    [CONTROL_ALL, CRM_ALL, 0],
    [CONTROL_ALL, ['0001_a.sql'], 1],
    ['none', CRM_ALL, 1],
    ['none', ['0001_a.sql'], 1],
    [['0001_c.sql'], CRM_ALL, 1],
    [['0001_c.sql'], ['0001_a.sql'], 1],
    [[...CONTROL_ALL, '0003_x.sql'], CRM_ALL, 2],
    [[...CONTROL_ALL, '0003_x.sql'], ['0001_a.sql'], 2],
    [['0001_c.sql', '0009_zzz.sql'], CRM_ALL, 2],
  ]
  for (const [control, crm, exit] of matrix) {
    it(`control ${JSON.stringify(control)} x crm ${JSON.stringify(crm)} -> exit ${exit}`, async () => {
      const { w, code } = await run(control, crm)
      expect(code).toBe(exit)
      expect(writes(w)).toEqual([])
      const out = w.out.join('\n')
      expect(out.includes(controlNotConfigured('demo'))).toBe(control === 'absent')
      if (exit === 2) {
        expect(w.err.join('\n')).toMatch(/control database/)
        expect(w.err.join('\n')).toMatch(/0003_x\.sql|0009_zzz\.sql/)
        return
      }
      if (control === 'absent') {
        expect(out).not.toMatch(/\[control\]|\[crm\]/)
        return
      }
      const behind = control === 'none' || (control as string[]).length < CONTROL_ALL.length
      expect(out).toMatch(behind ? /\[control\] migrations: behind/ : /\[control\] migrations: current/)
      expect(out).toMatch(crm.length < CRM_ALL.length ? /\[crm\] migrations: behind/ : /\[crm\] migrations: current/)
    })
  }

  it('empty-state: no d1_migrations table on the control database is behind with every control migration pending', async () => {
    const { w, code } = await run('none', CRM_ALL)
    expect(code).toBe(1)
    const out = w.out.join('\n')
    expect(out).toMatch(/\[control\] migrations: behind \(0 applied, 2 expected/)
    for (const n of CONTROL_ALL) expect(out).toContain(`[control]   ${n}`)
    expect(out).not.toMatch(/\[crm\]   0/)
  })
  it('control is read on CONTROL_DB and crm on DB, in the same generated config', async () => {
    const { w } = await run(CONTROL_ALL, CRM_ALL)
    expect(w.wrangler.map((c) => bindingOf(c.args))).toEqual(['CONTROL_DB', 'DB'])
    expect(w.wrangler[0]!.configPath).toBe(w.wrangler[1]!.configPath)
    expect(JSON.parse(w.wrangler[0]!.configText!).d1_databases.map((d: any) => d.binding).sort()).toEqual(['CONTROL_DB', 'DB'])
  })
  it('a live version that differs is exit 1 even when both databases are current', async () => {
    expect((await run(CONTROL_ALL, CRM_ALL, '0.0.9')).code).toBe(1)
  })
})

describe('OPS275 gate refusals reach no write', () => {
  const upgrade = async (control: Tracker, crm: Tracker, o: { rollback?: boolean; version?: string } = {}) => {
    const w = makeWorld({
      settings: controlSettings(),
      processEnv: { CONFIRM_REMOTE: '1' },
      health: () => json(200, { ...HEALTH, version: o.version ?? '0.0.9' }),
      runner: (args) => answer(bindingOf(args) === 'CONTROL_DB' ? control : crm),
    })
    return { w, code: await runUpgrade(['--env', 'demo', ...(o.rollback ? ['--rollback'] : [])], w.deps) }
  }
  const noWrite = (w: World) => {
    expect(w.wrangler.filter((c) => c.args.join(' ').match(/migrations apply|deploy/))).toEqual([])
  }
  it('a control name unknown to the package is refused (exit 2)', async () => {
    const { w, code } = await upgrade(['0001_c.sql', '0009_zzz.sql'], CRM_ALL)
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/control database.*install a newer release.*0009_zzz\.sql/)
    noWrite(w)
  })
  it('--rollback with a package control migration not applied is refused (exit 2)', async () => {
    const { w, code } = await upgrade(['0001_c.sql'], CRM_ALL, { rollback: true, version: '0.2.0' })
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/control database.*0002_d\.sql/)
    noWrite(w)
  })
  it('--rollback with everything applied still passes the gate', async () => {
    const { w, code } = await upgrade(CONTROL_ALL, CRM_ALL, { rollback: true, version: '0.2.0' })
    expect(code).toBe(0)
    expect(w.wrangler.filter((c) => c.args[0] === 'deploy')).toHaveLength(1)
    expect(w.wrangler.filter((c) => c.args.join(' ').includes('migrations apply'))).toEqual([])
  })
})

interface Sim {
  control: Tracker
  crm: Tracker
  deployed: boolean
  failControlApply?: boolean
  controlApplyNoop?: boolean
}
describe('OPS275 upgrade order and failure', () => {
  function worldFor(s: Sim, o: WorldOptions = {}): World {
    return makeWorld({
      settings: controlSettings(),
      processEnv: { CONFIRM_REMOTE: '1' },
      ...o,
      fetch: (url) => {
        const path = new URL(url).pathname
        if (path === '/health') {
          return json(200, { ...HEALTH, initialised: true, version: s.deployed ? '0.1.0' : '0.0.9', migrations: { ...HEALTH.migrations, status: s.crm !== 'none' && CRM_ALL.every((n) => (s.crm as string[]).includes(n)) ? 'current' : 'behind' } })
        }
        if (path === '/openapi.json') return json(404, { error: { code: 'not_found', message: 'not found' } })
        return json(401, { error: { code: 'unauthorized', message: 'unauthorized' } })
      },
      runner: (args) => {
        const b = bindingOf(args)
        if (args[0] === 'deploy') {
          s.deployed = true
          return { status: 0, stdout: 'deployed', stderr: '' }
        }
        if (args[1] === 'migrations') {
          if (b === 'CONTROL_DB') {
            if (s.failControlApply) return { status: 1, stdout: '', stderr: 'control apply blew up' }
            if (!s.controlApplyNoop) s.control = [...CONTROL_ALL]
          } else s.crm = [...CRM_ALL]
          return { status: 0, stdout: 'applied', stderr: '' }
        }
        return answer(b === 'CONTROL_DB' ? s.control : s.crm)
      },
    })
  }
  const step = (c: { args: string[] }) => `${c.args[0] === 'deploy' ? 'deploy' : c.args[1] === 'migrations' ? 'apply' : 'read'}:${c.args[0] === 'deploy' ? '' : bindingOf(c.args)}`
  const steps = (w: World) => w.wrangler.map(step)

  it('control apply, control tracker, crm apply, crm tracker, deploy, each on its own binding in the same generated config', async () => {
    const w = worldFor({ control: 'none', crm: [], deployed: false })
    expect(await runUpgrade(['--env', 'demo'], w.deps)).toBe(0)
    // The gate reads both trackers first; the writes follow in the documented order.
    expect(steps(w)).toEqual(['read:CONTROL_DB', 'read:DB', 'apply:CONTROL_DB', 'read:CONTROL_DB', 'apply:DB', 'read:DB', 'deploy:'])
    expect(new Set(w.wrangler.map((c) => c.configPath)).size).toBe(1)
    const out = w.out.join('\n')
    expect(out).toMatch(/\[control\] migrations to apply \(2\)/)
    expect(out).toMatch(/\[crm\] migrations to apply \(2\)/)
    expect(out.indexOf('migrate control: applied')).toBeLessThan(out.indexOf('migrate crm: applied'))
  })
  it('a failing control apply is exit 3 naming the step, with no crm apply and no deploy', async () => {
    const w = worldFor({ control: [], crm: [], deployed: false, failControlApply: true })
    expect(await runUpgrade(['--env', 'demo'], w.deps)).toBe(3)
    expect(w.err.join('\n')).toMatch(/migrate control failed.*control apply blew up/)
    expect(steps(w).filter((x) => x === 'apply:DB' || x === 'deploy:')).toEqual([])
  })
  it('a control tracker still behind after the apply is exit 3 naming the step, with no crm apply and no deploy', async () => {
    const w = worldFor({ control: [], crm: [], deployed: false, controlApplyNoop: true })
    expect(await runUpgrade(['--env', 'demo'], w.deps)).toBe(3)
    expect(w.err.join('\n')).toMatch(/tracker check control failed.*behind/)
    expect(steps(w).filter((x) => x === 'apply:DB' || x === 'deploy:')).toEqual([])
  })
  it('without control_d1 the crm path is as before, plus the P1 line', async () => {
    const w = worldFor({ control: 'none', crm: [], deployed: false }, { settings: validSettings() })
    expect(await runUpgrade(['--env', 'demo'], w.deps)).toBe(0)
    expect(steps(w)).toEqual(['read:DB', 'apply:DB', 'read:DB', 'deploy:'])
    expect(w.out.join('\n')).toContain(controlNotConfigured('demo'))
    expect(JSON.parse(w.wrangler[0]!.configText!).d1_databases).toHaveLength(1)
  })
  it('--dry-run records no write', async () => {
    const w = worldFor({ control: 'none', crm: [], deployed: false })
    expect(await runUpgrade(['--env', 'demo', '--dry-run'], w.deps)).toBe(0)
    expect(steps(w)).toEqual(['read:CONTROL_DB', 'read:DB'])
  })
  it('--rollback records no migrations apply for either binding', async () => {
    let deployed = false
    const w = makeWorld({
      settings: controlSettings(),
      processEnv: { CONFIRM_REMOTE: '1' },
      fetch: (url) => {
        const path = new URL(url).pathname
        if (path === '/health') return json(200, { ...HEALTH, initialised: true, version: deployed ? '0.1.0' : '0.2.0', migrations: { ...HEALTH.migrations, status: 'ahead' } })
        return path === '/openapi.json' ? json(404, { error: { code: 'not_found', message: 'x' } }) : json(401, { error: { code: 'unauthorized', message: 'x' } })
      },
      runner: (args) => {
        if (args[0] === 'deploy') deployed = true
        return args[0] === 'deploy' ? { status: 0, stdout: '', stderr: '' } : answer(bindingOf(args) === 'CONTROL_DB' ? CONTROL_ALL : CRM_ALL)
      },
    })
    expect(await runUpgrade(['--env', 'demo', '--rollback'], w.deps)).toBe(0)
    expect(w.err).toEqual([])
    expect(w.wrangler.map(step).filter((x) => x.startsWith('apply'))).toEqual([])
    expect(w.wrangler.map(step)).toContain('deploy:')
  })
})
