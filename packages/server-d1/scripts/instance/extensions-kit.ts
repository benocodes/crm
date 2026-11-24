// Test support for the extensions file in `redeploy` and `upgrade` ([[CORE543]]): a fake wrangler that serves `d1 execute --remote --command` and `--file` from a real SQLite (`node:sqlite`, the engine D1 is; the
// runner is synchronous, as `spawnSync` is, so Miniflare's asynchronous D1 cannot stand behind it, 543.11), a `/health` that reports what the last deploy staged, and the call log the tests read.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { D1Like } from '@vibase/storage-d1'
import { statusOf } from '../remote.js'
import {
  bindingOf,
  CONTROL_ALL,
  makeWorld,
  mkTmp,
  NO_TRACKER_JSON,
  PKG_COMMIT,
  trackerJson,
  type World,
  type WorldOptions,
} from './test-kit.js'
import type { RunResult } from './types.js'

export const ALL = ['0001_a.sql', '0002_b.sql']
export const PKG_VERSION = '0.1.0'

/** A D1-shaped handle over a synchronous SQLite, so the library's own readers and apply run on the same database the fake wrangler serves. */
export function sqliteD1(db: DatabaseSync): D1Like {
  const prepared = (sql: string, binds: unknown[]) => ({
    bind: (...b: unknown[]) => prepared(sql, b),
    all: async () => ({ results: db.prepare(sql).all(...(binds as never[])) as unknown[], success: true }),
    first: async () => (db.prepare(sql).get(...(binds as never[])) ?? null) as never,
    run: async () => {
      db.prepare(sql).run(...(binds as never[]))
      return { success: true, results: [] }
    },
    raw: async () => [],
  })
  return {
    prepare: (sql: string) => prepared(sql, []) as never,
    batch: async (statements: { run(): Promise<unknown> }[]) => {
      const out = []
      for (const s of statements) out.push(await s.run())
      return out as never
    },
  } as D1Like
}

/** The hash of every file under a directory, by relative path: the "package files are never modified" check. */
export function treeHash(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else h.update(p.slice(dir.length)).update(readFileSync(p))
    }
  }
  walk(dir)
  return h.digest('hex')
}

export const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex')

/** What `/health.extensions` shows: the shapes of [[CORE543]] P1, plus `'absent'` for an older build (no key). */
export type HealthExt = 'absent' | null | { digest: string; objects: string[] } | { digest: string; error: string }

export interface ExtSim {
  db: DatabaseSync
  d1: D1Like
  crm: string[] | null
  control: string[]
  /** `/health.extensions` before the deploy. */
  live: HealthExt
  /** The deploy succeeds but `/health` keeps answering the old build. */
  neverSwitch?: boolean
  /** After the deploy `/health` shows this instead of what the deploy staged. */
  after?: HealthExt
  failFile?: boolean
  failDeploy?: boolean
  /** What the last deploy staged, read at the call. */
  staged: {
    files: string[]
    module: string | null
    moduleBytes: Buffer | null
    config: Record<string, any> | null
  } | null
  deployed: boolean
  /** The statements the last `--file` ran. */
  fileRuns: string[][]
}
export const extSim = (over: Partial<ExtSim> = {}): ExtSim => {
  const db = new DatabaseSync(':memory:')
  // The core tables a reference may target exist in a deployed database; foreign keys stay off here (a row is inserted with made-up owners), D1's own enforcement is `@vibase/api`'s suites'.
  db.exec('pragma foreign_keys = off')
  db.exec(`create table companies (id text primary key, organization_id text) strict`)
  db.exec(`create table principals (id text primary key, organization_id text) strict`)
  return {
    db,
    d1: sqliteD1(db),
    crm: [...ALL],
    control: [...CONTROL_ALL],
    live: null,
    staged: null,
    deployed: false,
    fileRuns: [],
    ...over,
  }
}

/** Splits a `--file`'s text the way the apply statements are written: one statement per `;` + newline. */
export const statementsOf = (text: string): string[] =>
  text
    .split(/;\n/)
    .map((s) => s.trim())
    .filter(Boolean)

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const healthExt = (ext: HealthExt): Record<string, unknown> => (ext === 'absent' ? {} : { extensions: ext })

export function extRunner(s: ExtSim): (args: string[]) => RunResult {
  return (args) => {
    const b = bindingOf(args)
    const sub = args.slice(0, 3).join(' ')
    if (sub.startsWith('d1 execute')) {
      if (b === 'CONTROL_DB') return { status: 0, stdout: trackerJson(s.control), stderr: '' }
      const file = args.indexOf('--file')
      if (file >= 0) {
        const statements = statementsOf(readFileSync(args[file + 1]!, 'utf8'))
        const run = s.failFile ? statements.slice(0, 1) : statements
        for (const st of run) s.db.exec(st)
        s.fileRuns.push(run)
        return s.failFile
          ? { status: 1, stdout: '', stderr: 'D1 import failed after the first statement' }
          : { status: 0, stdout: '[]', stderr: '' }
      }
      const sql = args[args.indexOf('--command') + 1]!
      if (/d1_migrations/.test(sql))
        return s.crm === null
          ? { status: 1, stdout: NO_TRACKER_JSON, stderr: '' }
          : { status: 0, stdout: trackerJson(s.crm), stderr: '' }
      try {
        const results = s.db.prepare(sql).all()
        return { status: 0, stdout: JSON.stringify([{ results, success: true, meta: {} }]), stderr: '' }
      } catch (e) {
        return {
          status: 1,
          stdout: JSON.stringify({ error: { text: 'query failed', notes: [{ text: String(e) }] } }),
          stderr: '',
        }
      }
    }
    if (sub.startsWith('d1 migrations apply')) {
      if (b === 'CONTROL_DB') return { status: 0, stdout: 'applied', stderr: '' }
      s.crm = [...ALL]
      return { status: 0, stdout: 'applied', stderr: '' }
    }
    if (sub.startsWith('deploy')) {
      const configPath = args[args.indexOf('-c') + 1]!
      const dir = dirname(configPath)
      const modulePath = join(dir, 'vibase-extensions.json')
      s.staged = {
        files: readdirSync(dir).sort(),
        module: existsSync(modulePath) ? readFileSync(modulePath, 'utf8') : null,
        moduleBytes: existsSync(modulePath) ? readFileSync(modulePath) : null,
        config: JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>,
      }
      if (s.failDeploy) return { status: 1, stdout: '', stderr: 'deploy blew up' }
      s.deployed = true
      return { status: 0, stdout: 'deployed', stderr: '' }
    }
    return { status: 1, stdout: '', stderr: `unexpected wrangler call ${args.join(' ')}` }
  }
}

/** What `/health.extensions` shows once the deploy staged `module` (the Worker's rule, P1). */
export function healthOfModule(text: string | null): HealthExt {
  if (text === null) return null
  const digest = sha256(text)
  try {
    const o = JSON.parse(text) as { objects?: Record<string, unknown> }
    const names = Object.keys(o.objects ?? {}).sort()
    return names.length === 0 ? null : { digest, objects: names }
  } catch {
    return { digest, error: 'extensions_invalid' }
  }
}

export function extWorld(s: ExtSim, health: Record<string, any>, o: WorldOptions = {}): World {
  return makeWorld({
    ...o,
    fetch: (url) => {
      const path = new URL(url).pathname
      if (path === '/health') {
        const switched = s.deployed && !s.neverSwitch
        const { commit: _c, extensions: _e, ...rest } = health
        return json(200, {
          ...rest,
          commit: switched ? PKG_COMMIT : '1111111',
          initialised: true,
          version: switched ? PKG_VERSION : '0.0.9',
          migrations: { ...health.migrations, status: statusOf(s.crm, ALL) },
          ...healthExt(
            switched ? (s.after !== undefined ? s.after : healthOfModule(s.staged?.module ?? null)) : s.live,
          ),
        })
      }
      if (path === '/openapi.json') return json(404, { error: { code: 'not_found', message: 'not found' } })
      return json(401, { error: { code: 'unauthorized', message: 'unauthorized' } })
    },
    runner: extRunner(s),
  })
}

/** A file in a fresh temp directory. */
export function extFile(name: string, content: unknown): string {
  const p = join(mkTmp('core543-ext-'), name)
  writeFileSync(p, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  return p
}

export const ext = {
  a: () => ({
    version: 1,
    objects: {
      projects__c: {
        label: 'Projects',
        fields: {
          name: { kind: 'text', required: true },
          code: { kind: 'text', unique: true },
          status: { kind: 'enum', values: ['open', 'closed'] },
        },
      },
      milestones__c: { label: 'Milestones', fields: { project: { kind: 'reference', target: 'projects__c' } } },
    },
  }),
  /** A plus a nullable field. */
  b: () => {
    const a = ext.a()
    return {
      ...a,
      objects: {
        ...a.objects,
        projects__c: { ...a.objects.projects__c, fields: { ...a.objects.projects__c.fields, note: { kind: 'text' } } },
      },
    }
  },
  /** `code` as an integer: a kind change against A. */
  c: () => {
    const a = ext.a()
    return {
      ...a,
      objects: {
        ...a.objects,
        projects__c: {
          ...a.objects.projects__c,
          fields: { ...a.objects.projects__c.fields, code: { kind: 'integer', unique: true } },
        },
      },
    }
  },
  empty: () => ({ version: 1, objects: {} }),
}
