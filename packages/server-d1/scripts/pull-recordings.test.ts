import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { parseRecordingSwitch } from '@vault/api'
import { PULL_DIR, PULL_VERBS, bucketOf, getCommand, parseIndex, runPull, safeKey, type PullDeps } from './pull-recordings.js'
import { REPO_ROOT, RemoteRefusal, type Cmd, type ConfigLike } from './remote.js'

// [[CHN5]] D78 ([[CHN153]]): the user-run pull of an env's recordings. Read-only by construction.
const CONFIG: ConfigLike & { r2_buckets?: Array<{ binding: string; bucket_name: string }> } = {
  name: 'vault-hq',
  d1_databases: [{ binding: 'DB', database_name: 'vault-hq', database_id: '23fda5fd-1508-462a-b700-53ad047472e3', remote: true }],
  r2_buckets: [{ binding: 'BODIES', bucket_name: 'vault-hq-bodies' }],
}
const KEYS = ['_recordings/20261106T100000Z-inst-1/001-profile-200-abcdef.json', '_recordings/20261106T100000Z-inst-1/002-message_raw-200-012345.json']
const INDEX = JSON.stringify({ version: 1, objects: KEYS.map((key) => ({ key, kind: 'profile', status: 200 })) })

function rig(overrides: Partial<PullDeps> = {}, config = CONFIG) {
  const cmds: Cmd[] = []
  const dirs: string[] = []
  const lines: string[] = []
  const deps: PullDeps = {
    loadEnv: () => {},
    readConfig: () => config,
    exec: (cmd) => {
      cmds.push(cmd)
      return { status: 0 }
    },
    readFile: () => INDEX,
    mkdir: (p) => void dirs.push(p),
    log: (l) => void lines.push(l),
    ...overrides,
  }
  return { deps, cmds, dirs, lines }
}

describe('guards (the same as the other remote scripts)', () => {
  it('refuses without CONFIRM_REMOTE=1, without --env, and for the local-only top level, before any command', () => {
    const r = rig()
    expect(() => runPull(['--env', 'hq'], {}, r.deps)).toThrow(RemoteRefusal)
    expect(() => runPull([], { CONFIRM_REMOTE: '1' }, r.deps)).toThrow(RemoteRefusal)
    const top = rig({}, { ...CONFIG, name: 'vault' })
    expect(() => runPull(['--env', 'x'], { CONFIRM_REMOTE: '1' }, top.deps)).toThrow(RemoteRefusal)
    expect([...r.cmds, ...top.cmds]).toEqual([])
  })
  it('refuses an env with no BODIES bucket', () => {
    expect(() => bucketOf({ ...CONFIG, r2_buckets: [] }, 'hq')).toThrow(RemoteRefusal)
    expect(bucketOf(CONFIG, 'hq')).toBe('vault-hq-bodies')
  })
})

describe('the pull', () => {
  it('reads the index, then gets each listed object into <PULL_DIR>/<env>/, and nothing else', () => {
    const r = rig()
    expect(runPull(['--env', 'hq'], { CONFIRM_REMOTE: '1' }, r.deps)).toBe(0)
    expect(r.cmds).toHaveLength(1 + KEYS.length)
    expect(r.cmds[0]!.args).toEqual(expect.arrayContaining(['r2', 'object', 'get', 'vault-hq-bodies/_recordings/index.json', '--remote', '--env', 'hq']))
    for (const [i, key] of KEYS.entries()) {
      const a = r.cmds[i + 1]!.args
      expect(a).toContain(`vault-hq-bodies/${key}`)
      expect(a[a.indexOf('--file') + 1]).toBe(join(PULL_DIR, 'hq', key.replace('_recordings/', '')))
    }
  })
  it('is read-only: every command is `wrangler r2 object get --remote`; the command list holds no put, delete or other verb', () => {
    expect(PULL_VERBS).toEqual(['get'])
    const r = rig()
    runPull(['--env', 'hq'], { CONFIRM_REMOTE: '1' }, r.deps)
    for (const c of r.cmds) {
      expect(c.command).toBe('pnpm')
      expect(c.args.slice(0, 5)).toEqual(['exec', 'wrangler', 'r2', 'object', 'get'])
      expect(c.args).toContain('--remote')
      expect(c.args.some((a) => ['put', 'delete', 'create', 'bucket'].includes(a))).toBe(false)
    }
    expect(readFileSync(new URL('./pull-recordings.ts', import.meta.url), 'utf8')).not.toMatch(/object['"]?,\s*['"](put|delete)|\bwrangler r2 object (put|delete)/)
  })
  it('refuses an index that lists a key outside _recordings/ or with a path trick, and runs no get for it', () => {
    for (const bad of ['../etc/passwd', '/abs', '_recordings/../x', '_recordings/a b', 'other/key', '_recordings/a;rm -rf', '_recordings//x']) {
      expect(safeKey(bad)).toBe(false)
      expect(() => parseIndex(JSON.stringify({ version: 1, objects: [{ key: bad }] }))).toThrow()
    }
    expect(safeKey(KEYS[0]!)).toBe(true)
  })
  it('an index that is missing or not JSON is a clear failure, not a partial pull', () => {
    const r = rig({ exec: (c) => (r2.push(c), { status: 1 }) })
    const r2: Cmd[] = []
    expect(runPull(['--env', 'hq'], { CONFIRM_REMOTE: '1' }, r.deps)).toBe(1)
    expect(r2).toHaveLength(1)
    expect(() => parseIndex('nope')).toThrow()
  })
})

describe('the output folder', () => {
  it('is gitignored', () => {
    const r = spawnSync('git', ['check-ignore', '-q', join(PULL_DIR, 'hq', 'x', 'y.json')], { cwd: REPO_ROOT })
    expect(r.status).toBe(0)
  })
})

describe('where the switch may be set', () => {
  const config = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')) as { vars?: Record<string, unknown>; env?: Record<string, { vars?: Record<string, unknown> }> }
  it('env.hq.vars may carry it, and then it is an ISO-8601 UTC instant ending in Z that parses as a valid switch', () => {
    const v = config.env?.hq?.vars?.GOOGLE_RECORDING_UNTIL
    if (v === undefined) return // removed after the run: the normal state
    expect(typeof v).toBe('string')
    expect(v as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
    // Judged by the Worker's own parser, as of one day before the instant (the cap is relative to deploy time, which is not checkable here).
    const sw = parseRecordingSwitch(v as string, new Date(Date.parse(v as string) - 86_400_000))
    expect(sw).toEqual({ until: new Date(v as string), problem: null })
  })
  it('the top level and every other env (smoked1 included) never carry it', () => {
    expect(config.vars ?? {}).not.toHaveProperty('GOOGLE_RECORDING_UNTIL')
    for (const [name, e] of Object.entries(config.env ?? {})) if (name !== 'hq') expect(e.vars ?? {}).not.toHaveProperty('GOOGLE_RECORDING_UNTIL')
  })
  it('setup:remote never writes it', () => {
    for (const f of ['gmail.ts', 'config-editor.ts', 'run.ts', 'steps.ts', 'commands.ts']) expect(readFileSync(new URL(`./setup/${f}`, import.meta.url), 'utf8')).not.toContain('GOOGLE_RECORDING_UNTIL')
  })
})
