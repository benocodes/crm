// Test support for the instance commands: a real staged release package on disk, settings and secrets files with real modes, a fake fetch and a
// fake wrangler runner that record every call. Nothing here reaches a network or a Cloudflare account.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS } from '@vibase/storage-d1'
import { sources } from '../../../release/src/fixtures.js'
import { stageServer } from '../../../release/src/stage.js'
import { composeD1Worker } from '../../src/compose.js'
import { openWorkerD1 } from '../../src/test/kit.js'
import type { InstanceDeps, OpenD1Options, RunResult } from './types.js'

export const UUID = '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b'
export const TOKEN = 'e2e-token-SECRET-0000'
export const ACCOUNT = 'e2e-acct-0000'
export const WRANGLER_BASE = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')

const dirs: string[] = []
export const cleanup = () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) }
export const mkTmp = (prefix = 'ops231-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }

/** The `/health` body exactly as `compose.ts` returns it, captured from the real Worker on a migrated test database. */
export async function captureHealthBody(): Promise<Record<string, any>> {
  const w = await openWorkerD1()
  try {
    const res = await composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '' }).fetch(new Request('https://w.test/health'))
    return (await res.json()) as Record<string, any>
  } finally {
    await w.dispose()
  }
}

/** `wrangler d1 execute --json` output of `select name from d1_migrations`, in the recorded shape. */
export const trackerJson = (names: string[]): string => JSON.stringify([{ results: names.map((name) => ({ name })), success: true, meta: { duration: 0 } }])
/** The recorded error output of a database with no tracker table (`scripts/fixtures/d1-execute-missing-table.json` shape, the remote wording). */
export const NO_TRACKER_JSON = '{"error":{"text":"A request to the Cloudflare API (/accounts/a/d1/database/b/query) failed.","notes":[{"text":"no such table: d1_migrations: SQLITE_ERROR [code: 7500]"}],"code":7500}}'

export interface PackageFixture {
  dir: string
  migrations: string[]
}
/** The release layout as `stageServer` writes it: a real package directory with the real base config of `wrangler.jsonc`. */
export function stagedPackage(): PackageFixture {
  const s = sources()
  dirs.push(s.root)
  const dir = mkTmp('ops231-pkg-')
  stageServer({ ...s, baseConfigText: WRANGLER_BASE, outDir: dir })
  return { dir, migrations: s.migrations.map((m) => m.name) }
}

/** The first line every instance command prints (OPS240 P1, D13): the program, its version and commit, and how many files verified. */
export function packageLine(dir: string): string {
  const r = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')) as { version: string; commit: string; files: Record<string, string> }
  return `package: vibase-server/${r.version} (${r.commit}), ${Object.keys(r.files).length} files verified`
}

export const validSettings = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  env: 'demo',
  worker: 'vault-demo',
  api_host: 'api.demo.invalid',
  d1: { name: 'vault-demo', id: UUID },
  r2_bucket: 'vault-demo-bodies',
  workflow: { name: 'vault-demo-mail-sync' },
  vars: { AUTH_PROVIDER: '' },
  ...over,
})

export interface WranglerCall {
  args: string[]
  env: Record<string, string>
  cwd: string
  /** Stdin (`secret bulk`). */
  input?: string
  /** The generated config as it was on disk during the call. */
  configText: string | null
  configPath: string | null
}
export interface World {
  deps: InstanceDeps
  pkg: PackageFixture
  config: string
  settingsPath: string
  secretsPath: string
  tmpRoot: string
  fetchUrls: string[]
  fetchCalls: { url: string; init?: RequestInit }[]
  /** Milliseconds the fake clock advanced (the verify loop's sleeps). */
  clock: { t: number }
  wrangler: WranglerCall[]
  /** Every `openD1` call. */
  openD1Calls: OpenD1Options[]
  out: string[]
  err: string[]
  all(): string
}
export interface WorldOptions {
  settings?: Record<string, unknown> | null
  secretsMode?: number | null
  secretsText?: string
  processEnv?: Record<string, string | undefined>
  /** The `/health` answer: a Response factory, or an Error to throw. */
  health?: () => Response | Promise<Response>
  /** Answers every request instead (a router by URL); `health` is ignored when set. */
  fetch?: (url: string, init?: RequestInit) => Response | Promise<Response>
  /** What the fake wrangler answers. */
  runner?: (args: string[], env: Record<string, string>, input?: string) => RunResult
  /** `setup`'s bootstrap D1 (default: any call is a test error). */
  openD1?: InstanceDeps['openD1']
}
export const SECRETS_TEXT = `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${TOKEN}\n`

export function makeWorld(o: WorldOptions = {}): World {
  const pkg = stagedPackage()
  const home = mkTmp('ops231-home-')
  const config = join(home, 'config')
  const dir = join(config, 'vibase', 'instances')
  mkdirSync(dir, { recursive: true })
  const settingsPath = join(dir, 'demo.json')
  const secretsPath = join(dir, 'demo.env')
  if (o.settings !== null) writeFileSync(settingsPath, JSON.stringify(o.settings ?? validSettings()))
  if (o.secretsMode !== null) {
    writeFileSync(secretsPath, o.secretsText ?? SECRETS_TEXT)
    chmodSync(secretsPath, o.secretsMode ?? 0o600)
  }
  const tmpRoot = mkTmp('ops231-tmproot-')
  const out: string[] = []
  const err: string[] = []
  const fetchUrls: string[] = []
  const fetchCalls: { url: string; init?: RequestInit }[] = []
  const clock = { t: 0 }
  const wrangler: WranglerCall[] = []
  const openD1Calls: OpenD1Options[] = []
  const deps: InstanceDeps = {
    packageDir: pkg.dir,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchUrls.push(String(input))
      fetchCalls.push({ url: String(input), init })
      if (o.fetch) return o.fetch(String(input), init)
      return (o.health ?? (() => new Response('{}', { status: 200 })))()
    }) as typeof fetch,
    runWrangler: (args, opts) => {
      const c = args.indexOf('-c')
      const configPath = c >= 0 ? args[c + 1]! : null
      wrangler.push({ args, env: opts.env, cwd: opts.cwd, input: opts.input, configPath, configText: configPath && existsSync(configPath) ? readFileSync(configPath, 'utf8') : null })
      return (o.runner ?? (() => ({ status: 0, stdout: trackerJson(pkg.migrations), stderr: '' })))(args, opts.env, opts.input)
    },
    openD1: async (opts) => {
      openD1Calls.push(opts)
      if (!o.openD1) throw new Error('unexpected openD1 call in a test that gave none')
      return o.openD1(opts)
    },
    env: { XDG_CONFIG_HOME: config, PATH: '/usr/bin', HOME: home, ...o.processEnv },
    homedir: home,
    tmpRoot,
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    now: () => clock.t,
    sleep: async (ms) => void (clock.t += ms),
  }
  return { deps, pkg, config, settingsPath, secretsPath, tmpRoot, fetchUrls, fetchCalls, clock, wrangler, openD1Calls, out, err, all: () => [...out, ...err].join('\n') }
}
