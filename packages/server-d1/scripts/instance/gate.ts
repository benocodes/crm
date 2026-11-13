// The compatibility gate ([[OPS210]] D14, [[OPS231]]): read-only. It verifies the installed package, reads the settings and secrets, asks the live
// instance's `/health` and reads wrangler's migration tracker, and refuses or reports. It never runs a write command.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyRelease, type ReleaseManifest } from '../../../release/src/manifest.js'
import { parseTrackerOutput } from '../remote.js'
import { withGeneratedConfig } from './config.js'
import { defaultSecretsPath, loadSecrets, type Secrets } from './secrets.js'
import { defaultSettingsPath, loadSettings } from './settings.js'
import { InstanceRefusal, type InstanceDeps, type InstanceSettings } from './types.js'

export interface GateOptions {
  envName: string
  settingsPath?: string
  secretsPath?: string
}
export interface GateOutcome {
  manifest: ReleaseManifest
  settings: InstanceSettings
  settingsPath: string
  live: { version: string; commit: string | null }
  /** `null`: no tracker table. */
  applied: string[] | null
  /** Names in the package not applied yet, in release order. */
  pending: string[]
  notes: string[]
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
export function parseSemver(v: string): [number, number, number, string] | null {
  const m = SEMVER.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''] : null
}
/** Negative when `a` is older than `b`; a prerelease is older than its release. Both must be semver. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) throw new Error('compareSemver needs semver versions')
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
  if (x[3] === y[3]) return 0
  if (x[3] === '') return 1
  if (y[3] === '') return -1
  return x[3] < y[3] ? -1 : 1
}

const HEALTH_TIMEOUT_MS = 15_000

async function readHealth(url: string, deps: InstanceDeps): Promise<{ version: string; commit: string | null }> {
  let res: Response
  try {
    res = await deps.fetch(url, { redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
  } catch (e) {
    throw new InstanceRefusal(`cannot reach ${url}: ${e instanceof Error ? e.message : 'request failed'}`)
  }
  if (res.status !== 200) throw new InstanceRefusal(`${url} answered ${res.status}, not 200: is this the instance's api_host?`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  const version = (body as { version?: unknown } | null | undefined)?.version
  if (typeof version !== 'string') throw new InstanceRefusal(`${url} answered 200 but not with a vault health body (no version string): is this the instance's api_host?`)
  const commit = (body as { commit?: unknown }).commit
  return { version, commit: typeof commit === 'string' ? commit : null }
}

/** The whole child environment of a wrangler run: no other variable of the process, and the two Cloudflare values from the secrets. */
function childEnv(deps: InstanceDeps, s: Secrets): Record<string, string> {
  const env: Record<string, string> = { CI: '1', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_ACCOUNT_ID: s.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: s.CLOUDFLARE_API_TOKEN }
  if (deps.env.PATH) env.PATH = deps.env.PATH
  if (deps.env.HOME) env.HOME = deps.env.HOME
  return env
}

/** wrangler's tracker table on the live database, read through the generated config. `null`: no tracker table. */
function readTracker(settings: InstanceSettings, secrets: Secrets, deps: InstanceDeps): string[] | null {
  return withGeneratedConfig({ packageDir: deps.packageDir, settings, tmpRoot: deps.tmpRoot }, (configPath) => {
    const r = deps.runWrangler(['d1', 'execute', 'DB', '--remote', '--json', '--command', 'select name from d1_migrations', '-c', configPath], { cwd: join(configPath, '..'), env: childEnv(deps, secrets) })
    try {
      return parseTrackerOutput(r.stdout)
    } catch (e) {
      const detail = (r.stderr.trim() || (e instanceof Error ? e.message : '')).slice(-400)
      throw new InstanceRefusal(`wrangler d1 execute failed (exit ${r.status ?? 'none'}): ${secrets.redact(detail)}`)
    }
  })
}

export async function runGate(o: GateOptions, deps: InstanceDeps): Promise<GateOutcome> {
  // (a) the installed package is the release, before any network call or child process.
  const problems = verifyRelease(deps.packageDir)
  if (problems.length > 0) throw new InstanceRefusal(`the installed package does not match its release.json: ${problems.map((p) => `${p.path} (${p.kind})`).join(', ')}: reinstall it`)
  const manifest = JSON.parse(readFileSync(join(deps.packageDir, 'release.json'), 'utf8')) as ReleaseManifest

  // (b) settings and secrets.
  const settingsPath = o.settingsPath ?? defaultSettingsPath(deps.env, deps.homedir, o.envName)
  const settings = loadSettings(settingsPath, o.envName)
  const secrets = loadSecrets(o.secretsPath ?? defaultSecretsPath(deps.env, deps.homedir, o.envName), deps.env)

  // (c) the live instance answers.
  const live = await readHealth(`https://${settings.api_host}/health`, deps)

  // (d) the database's applied migrations are all known to this release.
  const applied = readTracker(settings, secrets, deps)
  const known = manifest.migrations.map((m) => m.name)
  const unknown = (applied ?? []).filter((n) => !known.includes(n))
  if (unknown.length > 0) throw new InstanceRefusal(`the database has migrations this release does not know: install a newer release (${unknown.join(', ')})`)

  // (e) a newer semver live version refuses; (f) a non-semver one proceeds with a note.
  const notes: string[] = []
  if (parseSemver(live.version) === null) notes.push(`live version "${live.version}" is not a release version (a source deploy?): continuing`)
  else if (parseSemver(manifest.version) !== null && compareSemver(live.version, manifest.version) > 0) {
    throw new InstanceRefusal(`the instance runs ${live.version} and this package is ${manifest.version}: the instance is newer, install a newer release`)
  }
  const have = new Set(applied ?? [])
  return { manifest, settings, settingsPath, live, applied, pending: known.filter((n) => !have.has(n)), notes }
}
