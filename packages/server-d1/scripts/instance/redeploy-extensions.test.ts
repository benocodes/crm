// [[CORE543]] groups 1, 2 and 4 at the command: `redeploy --extensions` and `upgrade` over the fake wrangler on a real SQLite (extensions-kit). Remote apply (D30, P2), the place and the staging (D26, D27, P3, P7),
// and the digest guard matrix (D29, P1, P4).
import { readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { applyExtensions } from '../../../api/src/custom/apply.js'
import { parseExtensionsFile } from '../../../api/src/custom/extensions.js'
import { runStatus } from './status.js'
import { runRedeploy, runUpgrade } from './upgrade.js'
import { cleanup, captureHealthBody, validSettings, type World, type WorldOptions } from './test-kit.js'
import {
  ext,
  extFile,
  extSim,
  extWorld,
  healthOfModule,
  sha256,
  treeHash,
  type ExtSim,
  type HealthExt,
} from './extensions-kit.js'

afterEach(cleanup)
let HEALTH: Record<string, any>
beforeAll(async () => {
  HEALTH = await captureHealthBody()
}, 60_000)

const WRITE = (c: { args: string[] }) =>
  c.args[0] === 'deploy' || c.args.includes('--file') || (c.args[1] === 'migrations' && c.args[2] === 'apply')
const writes = (w: World) => w.wrangler.filter(WRITE)
const order = (w: World) =>
  w.wrangler
    .filter(WRITE)
    .map((c) => (c.args[0] === 'deploy' ? 'deploy' : c.args.includes('--file') ? 'file' : `migrate:${c.args[3]}`))
const noTemp = (w: World) => expect(readdirSync(w.tmpRoot)).toEqual([])
const settingsOf = (w: World) => JSON.parse(readFileSync(w.settingsPath, 'utf8')) as Record<string, any>
const digestOf = (j: unknown) => sha256(`${JSON.stringify(j, null, 2)}\n`)

async function go(
  mode: 'redeploy' | 'upgrade',
  s: ExtSim,
  argv: string[] = [],
  o: WorldOptions = {},
): Promise<{ w: World; code: number }> {
  const w = extWorld(s, HEALTH, o)
  const run = mode === 'redeploy' ? runRedeploy : runUpgrade
  return { w, code: await run(['--env', 'demo', ...argv], w.deps) }
}

describe('group 1: remote apply (D30, P2)', () => {
  it('the order is the core migrations, the --file statements, then the deploy; the tables exist after', async () => {
    const s = extSim({ crm: ['0001_a.sql'] })
    const p = extFile('a.json', ext.a())
    const { w, code } = await go('redeploy', s, ['--extensions', p, '--yes'])
    expect(w.err).toEqual([])
    expect(code).toBe(0)
    expect(order(w)).toEqual(['migrate:DB', 'file', 'deploy'])
    const tables = (
      s.db.prepare(`select name from sqlite_master where type='table' and name like '%\\_\\_c' escape '\\'`).all() as {
        name: string
      }[]
    ).map((t) => t.name)
    expect(tables.sort()).toEqual(['milestones__c', 'projects__c'])
    // The file command is the package's wrangler, remote, on the generated config.
    const file = w.wrangler.find((c) => c.args.includes('--file'))!
    expect(file.args.slice(0, 4)).toEqual(['d1', 'execute', 'DB', '--remote'])
    expect(file.args).toContain('-c')
    noTemp(w)
  })
  it('a D32 refusal (a kind change) is exit 2 with no write call, even with migrations pending and a yes', async () => {
    const s = extSim({ crm: ['0001_a.sql'] })
    await applyExtensions(
      (await import('./extensions-kit.js')).sqliteD1(s.db),
      parseExtensionsFile(JSON.stringify(ext.a())).objects,
    )
    const { w, code } = await go('redeploy', s, ['--extensions', extFile('c.json', ext.c()), '--yes'])
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/kind_changed/)
    expect(w.err.join('\n')).toMatch(/projects__c\.code/)
    expect(writes(w)).toEqual([])
    expect(settingsOf(w).extensions).toBeUndefined()
    noTemp(w)
  })
  it('a unique violation in live rows is exit 2 with no write call, naming the value and the ids', async () => {
    const s = extSim({ crm: ['0001_a.sql'] })
    const loose = { ...ext.a(), objects: { projects__c: { fields: { code: { kind: 'text' } } } } }
    await applyExtensions(
      (await import('./extensions-kit.js')).sqliteD1(s.db),
      parseExtensionsFile(JSON.stringify(loose)).objects,
    )
    for (const id of ['0190b2c4-0000-7000-8000-000000000001', '0190b2c4-0000-7000-8000-000000000002'])
      s.db
        .prepare(
          `insert into projects__c (id, organization_id, created_by, created_at, updated_at, code) values (?, 'o', 'u', 'x', 'x', 'DUP')`,
        )
        .run(id)
    const withUnique = { version: 1, objects: { projects__c: { fields: { code: { kind: 'text', unique: true } } } } }
    const { w, code } = await go('redeploy', s, ['--extensions', extFile('u.json', withUnique), '--yes'])
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/unique_violation/)
    expect(w.err.join('\n')).toContain('DUP')
    expect(w.err.join('\n')).toContain('0190b2c4-0000-7000-8000-000000000002')
    expect(writes(w)).toEqual([])
  })
  it('--dry-run writes nothing and prints the statements, created, added, indexed and archived', async () => {
    const s = extSim()
    await applyExtensions(
      (await import('./extensions-kit.js')).sqliteD1(s.db),
      parseExtensionsFile(JSON.stringify({ version: 1, objects: { old__c: { fields: {} } } })).objects,
    )
    const { w, code } = await go('redeploy', s, ['--extensions', extFile('a.json', ext.a()), '--dry-run'])
    expect(code).toBe(0)
    expect(writes(w)).toEqual([])
    const out = w.out.join('\n')
    expect(out).toMatch(/create: projects__c, milestones__c/)
    expect(out).toMatch(/archived: old__c/)
    expect(out).toMatch(/CREATE TABLE/)
    expect(settingsOf(w).extensions).toBeUndefined()
    expect(s.fileRuns).toEqual([])
  })
  it('a failing --file is exit 3 at the step apply, no deploy; the rerun plans what is left', async () => {
    const s = extSim({ failFile: true })
    const p = extFile('a.json', ext.a())
    const first = await go('redeploy', s, ['--extensions', p, '--yes'])
    expect(first.code).toBe(3)
    expect(first.w.err.join('\n')).toMatch(/apply failed/)
    expect(order(first.w)).toEqual(['file'])
    s.failFile = false
    const second = await go('redeploy', s, ['--extensions', p, '--dry-run'])
    expect(second.code).toBe(0)
    const left = second.w.out.join('\n')
    // The first statement ran; what is left is planned, the first table is not created again.
    expect(left).toMatch(/create: milestones__c$/m)
    expect(s.fileRuns[0]).toHaveLength(1)
  })
})

describe('group 2: the place and the staging (D26, D27, P3, P7)', () => {
  it('an invalid file is exit 2 with its rule code before any call, and the settings stay byte-equal', async () => {
    const s = extSim()
    const w = extWorld(s, HEALTH)
    const before = readFileSync(w.settingsPath, 'utf8')
    const code = await runRedeploy(
      ['--env', 'demo', '--extensions', extFile('bad.json', '{"version":1,"objects":{},"extend":{}}')],
      w.deps,
    )
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/extend_later/)
    expect(w.wrangler).toEqual([])
    expect(w.fetchUrls).toEqual([])
    expect(readFileSync(w.settingsPath, 'utf8')).toBe(before)
  })
  it('a real run records the absolute path; a later run without the flag stages the recorded file, byte-equal', async () => {
    const s = extSim()
    const p = extFile('a.json', ext.a())
    const first = await go('redeploy', s, ['--extensions', relative(process.cwd(), p), '--yes'])
    expect(first.code).toBe(0)
    expect(isAbsolute(settingsOf(first.w).extensions)).toBe(true)
    expect(settingsOf(first.w).extensions).toBe(p)
    expect(s.staged!.module).toBe(readFileSync(p, 'utf8'))
    expect(s.staged!.moduleBytes!.equals(readFileSync(p))).toBe(true)
    // The same settings, run again with no flag.
    const s2 = extSim({ live: healthOfModule(readFileSync(p, 'utf8')) })
    const second = await go('redeploy', s2, ['--yes'], { settings: validSettings({ extensions: p }) })
    expect(second.code).toBe(0)
    expect(s2.staged!.module).toBe(readFileSync(p, 'utf8'))
    expect(second.w.out.join('\n')).toContain(digestOf(ext.a()))
  })
  it('a recorded file that is missing or invalid is exit 2 naming the path, before any write', async () => {
    const missing = await go('redeploy', extSim(), ['--yes'], {
      settings: validSettings({ extensions: '/nonexistent/ext.json' }),
    })
    expect(missing.code).toBe(2)
    expect(missing.w.err.join('\n')).toContain('/nonexistent/ext.json')
    expect(writes(missing.w)).toEqual([])
    const bad = extFile('bad.json', '{nope')
    const invalid = await go('upgrade', extSim(), ['--yes'], { settings: validSettings({ extensions: bad }) })
    expect(invalid.code).toBe(2)
    expect(invalid.w.err.join('\n')).toContain(bad)
    expect(writes(invalid.w)).toEqual([])
  })
  it('the staged directory holds worker.js and the module (the default with no file), the config has the Text rule, and the package is untouched', async () => {
    const s = extSim()
    const w = extWorld(s, HEALTH)
    const before = treeHash(w.pkg.dir)
    expect(await runRedeploy(['--env', 'demo', '--yes'], w.deps)).toBe(0)
    expect(s.staged!.files).toEqual(expect.arrayContaining(['worker.js', 'vibase-extensions.json', 'wrangler.jsonc']))
    expect(s.staged!.module).toBe('{"version":1,"objects":{}}\n')
    expect(s.staged!.config!.main).toMatch(/worker\.js$/)
    expect(s.staged!.config!.main.startsWith(w.pkg.dir)).toBe(false)
    expect(JSON.stringify(s.staged!.config!.rules)).toMatch(/Text/)
    expect(JSON.stringify(s.staged!.config!.rules)).toMatch(/vibase-extensions\.json/)
    expect(treeHash(w.pkg.dir)).toBe(before)
    noTemp(w)
    // With a file: the module is the file's bytes and the package is still untouched.
    const p = extFile('a.json', ext.a())
    const s2 = extSim()
    const w2 = extWorld(s2, HEALTH)
    const before2 = treeHash(w2.pkg.dir)
    expect(await runRedeploy(['--env', 'demo', '--extensions', p, '--yes'], w2.deps)).toBe(0)
    expect(s2.staged!.module).toBe(readFileSync(p, 'utf8'))
    expect(treeHash(w2.pkg.dir)).toBe(before2)
  })
  it('upgrade has no --extensions flag; it uses the recorded path', async () => {
    const refused = await go('upgrade', extSim(), ['--extensions', '/x.json'])
    expect(refused.code).toBe(2)
    expect(refused.w.err.join('\n')).toMatch(/usage: vibase-server upgrade/)
    const p = extFile('a.json', ext.a())
    const s = extSim()
    const used = await go('upgrade', s, ['--yes'], { settings: validSettings({ extensions: p }) })
    expect(used.code).toBe(0)
    expect(s.staged!.module).toBe(readFileSync(p, 'utf8'))
  })
  it('a refusal never records the path', async () => {
    const s = extSim({ live: { digest: 'd'.repeat(64), objects: ['x__c'] } })
    const w = extWorld(s, HEALTH)
    const before = readFileSync(w.settingsPath, 'utf8')
    // The recorded file is gone: refusal. (The guard case is in the matrix.)
    expect(await runRedeploy(['--env', 'demo', '--extensions', '/nonexistent/e.json', '--yes'], w.deps)).toBe(2)
    expect(readFileSync(w.settingsPath, 'utf8')).toBe(before)
  })
})

describe('group 4: the digest guard matrix (D29, P1, P4)', () => {
  const A = digestOf(ext.a())
  const lives: [string, HealthExt][] = [
    ['no key', 'absent'],
    ['null', null],
    ['digest A', { digest: A, objects: ['milestones__c', 'projects__c'] }],
    ['error', { digest: 'e'.repeat(64), error: 'extensions_invalid' }],
  ]
  const runs: [string, (() => unknown) | null][] = [
    ['no file', null],
    ['file A', ext.a],
    ['file B', ext.b],
    ['a file with no objects', ext.empty],
  ]
  const refuses = (live: string, run: string) => (live === 'digest A' || live === 'error') && run === 'no file'
  for (const [liveName, live] of lives)
    for (const [runName, file] of runs)
      it(`redeploy: live ${liveName} x run ${runName}: ${refuses(liveName, runName) ? 'refused before any write' : 'proceeds and verifies'}`, async () => {
        const s = extSim({ live })
        const argv = file ? ['--extensions', extFile('x.json', file()), '--yes'] : ['--yes']
        const { w, code } = await go('redeploy', s, argv)
        if (refuses(liveName, runName)) {
          expect(code).toBe(2)
          expect(w.err.join('\n')).toContain('--extensions <path>')
          expect(w.err.join('\n')).toContain('a file with no objects')
          expect(writes(w)).toEqual([])
        } else {
          expect(w.err).toEqual([])
          expect(code).toBe(0)
          expect(s.staged).not.toBeNull()
        }
      })
  it('upgrade refuses live digest A with no recorded file, naming `redeploy --extensions`; a recorded file passes', async () => {
    const live = { digest: A, objects: ['milestones__c', 'projects__c'] }
    const s = extSim({ live })
    const { w, code } = await go('upgrade', s, ['--yes'])
    expect(code).toBe(2)
    expect(w.err.join('\n')).toContain('redeploy --extensions')
    expect(writes(w)).toEqual([])
    const p = extFile('a.json', ext.a())
    const ok = await go('upgrade', extSim({ live }), ['--yes'], { settings: validSettings({ extensions: p }) })
    expect(ok.code).toBe(0)
  })
  it('the plan prints both digests, live and run, for redeploy and upgrade', async () => {
    const live = { digest: A, objects: ['milestones__c', 'projects__c'] }
    const p = extFile('b.json', ext.b())
    const B = digestOf(ext.b())
    const r = await go('redeploy', extSim({ live }), ['--extensions', p, '--dry-run'])
    expect(r.w.out.join('\n')).toContain(A)
    expect(r.w.out.join('\n')).toContain(B)
    const u = await go('upgrade', extSim({ live }), ['--dry-run'], { settings: validSettings({ extensions: p }) })
    expect(u.w.out.join('\n')).toContain(A)
    expect(u.w.out.join('\n')).toContain(B)
  })
  it('status prints the live digest and its objects', async () => {
    const live = { digest: A, objects: ['milestones__c', 'projects__c'] }
    const w = extWorld(extSim({ live }), HEALTH)
    await runStatus(['--env', 'demo'], w.deps)
    expect(w.out.join('\n')).toMatch(new RegExp(`extensions: ${A}.*projects__c`))
    const none = extWorld(extSim({ live: null }), HEALTH)
    await runStatus(['--env', 'demo'], none.deps)
    expect(none.out.join('\n')).toMatch(/extensions: none/)
  })
  it('verify passes only the matching cell: a Worker that shows another digest, or an error, ends the run at verify (exit 3)', async () => {
    const p = extFile('a.json', ext.a())
    const other = { digest: 'f'.repeat(64), objects: ['projects__c'] }
    for (const after of [other, { digest: A, error: 'extensions_invalid' }, null] as HealthExt[]) {
      const { w, code } = await go('redeploy', extSim({ after }), ['--extensions', p, '--yes'])
      expect(code, JSON.stringify(after)).toBe(3)
      expect(w.err.join('\n')).toMatch(/verify/)
      expect(w.clock.t).toBeGreaterThanOrEqual(300_000)
    }
    // No file: the run expects none; a Worker that still shows a file never matches.
    const none = await go('redeploy', extSim({ after: other }), ['--yes'])
    expect(none.code).toBe(3)
    expect(none.w.err.join('\n')).toMatch(/verify/)
  })
})
