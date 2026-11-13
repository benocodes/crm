// The compatibility gate ([[OPS210]] D14, [[OPS231]]): read-only. It verifies the installed package, reads the settings and secrets, asks the live
// instance's `/health` and reads wrangler's migration tracker, and refuses or reports. It never runs a write command.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyRelease, type ReleaseManifest } from '../../../release/src/manifest.js'
import { controlNotConfigured, formatMigrationDiff, parseTrackerOutput } from '../remote.js'
import { withGeneratedConfig } from './config.js'
import { defaultSecretsPath, loadSecrets, type Secrets } from './secrets.js'
import { defaultSettingsPath, loadSettings } from './settings.js'
import { InstanceRefusal, type InstanceDeps, type InstanceSettings } from './types.js'

export interface GateOptions {
  envName: string
  settingsPath?: string
  secretsPath?: string
  /** `upgrade --rollback` ([[OPS234]] P3): (d) and (e) are replaced by package migrations ⊆ applied and a live version newer than the package's. */
  rollback?: boolean
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
  /** The control-plane database ([[OPS275]] D4): present only when the settings record `control_d1`. `applied` `null`: no tracker table; `pending` then lists every control migration. */
  control?: { expected: string[]; applied: string[] | null; pending: string[] }
  notes: string[]
  secrets: Secrets
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
  if (typeof version !== 'string') throw new InstanceRefusal(`${url} answered 200 but not with a Vibase health body (no version string): is this the instance's api_host?`)
  const commit = (body as { commit?: unknown }).commit
  return { version, commit: typeof commit === 'string' ? commit : null }
}

/** The whole child environment of a wrangler run: no other variable of the process, and the two Cloudflare values from the secrets. */
export function childEnv(deps: InstanceDeps, s: Secrets): Record<string, string> {
  const env: Record<string, string> = { CI: '1', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_ACCOUNT_ID: s.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: s.CLOUDFLARE_API_TOKEN }
  if (deps.env.PATH) env.PATH = deps.env.PATH
  if (deps.env.HOME) env.HOME = deps.env.HOME
  return env
}

/** wrangler's tracker table on the live database, read through the generated config. `null`: no tracker table. */
export function readTrackerAt(configPath: string, secrets: Secrets, deps: InstanceDeps, binding: 'DB' | 'CONTROL_DB' = 'DB'): string[] | null {
  const r = deps.runWrangler(['d1', 'execute', binding, '--remote', '--json', '--command', 'select name from d1_migrations', '-c', configPath], { cwd: join(configPath, '..'), env: childEnv(deps, secrets) })
  try {
    return parseTrackerOutput(r.stdout)
  } catch (e) {
    const detail = (r.stderr.trim() || (e instanceof Error ? e.message : '')).slice(-400)
    throw new InstanceRefusal(`wrangler d1 execute failed (exit ${r.status ?? 'none'}): ${secrets.redact(detail)}`)
  }
}
/** Both trackers from one generated config, the control one first when the settings record a control database. */
const readTrackers = (settings: InstanceSettings, secrets: Secrets, deps: InstanceDeps): { control: string[] | null | undefined; crm: string[] | null } =>
  withGeneratedConfig({ packageDir: deps.packageDir, settings, tmpRoot: deps.tmpRoot }, (configPath) => {
    const control = settings.control_d1 ? readTrackerAt(configPath, secrets, deps, 'CONTROL_DB') : undefined
    return { control, crm: readTrackerAt(configPath, secrets, deps, 'DB') }
  })

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

  const trackers = readTrackers(settings, secrets, deps)
  const applied = trackers.crm
  const known = manifest.migrations.map((m) => m.name)
  const controlKnown = (manifest.control_migrations ?? []).map((m) => m.name)
  const controlApplied = trackers.control
  const notes: string[] = []
  if (o.rollback) {
    // [[OPS234]] P3: a rollback deploys an older Worker on a newer schema; it may not need a migration the database lacks, and the instance must be newer.
    const have = new Set(applied ?? [])
    const missing = known.filter((n) => !have.has(n))
    if (controlApplied !== undefined) {
      const haveControl = new Set(controlApplied ?? [])
      const controlMissing = controlKnown.filter((n) => !haveControl.has(n))
      if (controlMissing.length > 0) throw new InstanceRefusal(`a rollback cannot add migrations: the control database lacks ${controlMissing.join(', ')} that this release has; run upgrade without --rollback`)
    }
    if (missing.length > 0) throw new InstanceRefusal(`a rollback cannot add migrations: the database lacks ${missing.join(', ')} that this release has; run upgrade without --rollback`)
    if (parseSemver(live.version) === null) notes.push(`live version "${live.version}" is not a release version (a source deploy?): continuing`)
    else if (parseSemver(manifest.version) !== null && compareSemver(live.version, manifest.version) <= 0) {
      throw new InstanceRefusal(`the instance runs ${live.version} and this package is ${manifest.version}: --rollback needs a newer instance; use upgrade without --rollback`)
    }
  } else {
    // (d, control) the control database's applied migrations are all known too (shipped ⊇ applied).
    const controlUnknown = (controlApplied ?? []).filter((n) => !controlKnown.includes(n))
    if (controlUnknown.length > 0) throw new InstanceRefusal(`the control database has migrations this release does not know: install a newer release (${controlUnknown.join(', ')})`)
    // (d) the database's applied migrations are all known to this release.
    const unknown = (applied ?? []).filter((n) => !known.includes(n))
    if (unknown.length > 0) throw new InstanceRefusal(`the database has migrations this release does not know: install a newer release (${unknown.join(', ')})`)
    // (e) a newer semver live version refuses; (f) a non-semver one proceeds with a note.
    if (parseSemver(live.version) === null) notes.push(`live version "${live.version}" is not a release version (a source deploy?): continuing`)
    else if (parseSemver(manifest.version) !== null && compareSemver(live.version, manifest.version) > 0) {
      throw new InstanceRefusal(`the instance runs ${live.version} and this package is ${manifest.version}: the instance is newer, install a newer release (or run an older package with --rollback)`)
    }
  }
  const have = new Set(applied ?? [])
  const haveControl = new Set(controlApplied ?? [])
  const control = controlApplied === undefined ? undefined : { expected: controlKnown, applied: controlApplied, pending: controlKnown.filter((n) => !haveControl.has(n)) }
  return { manifest, settings, settingsPath, live, applied, pending: known.filter((n) => !have.has(n)), ...(control ? { control } : {}), notes, secrets }
}

/** The tracker diff of each database ([[OPS275]] D14): with a control database each is prefixed `[control]` / `[crm]`; without, today's unprefixed CRM lines and the P1 line. */
export function diffLines(g: GateOutcome): string[] {
  const expected = g.manifest.migrations.map((m) => m.name)
  if (!g.control) return [...formatMigrationDiff(g.applied, expected), controlNotConfigured(g.settings.env)]
  return [
    ...formatMigrationDiff(g.control.applied ?? [], g.control.expected).map((l) => `[control] ${l}`),
    ...(g.control.applied === null ? ['[control]   (no d1_migrations table)'] : []),
    ...formatMigrationDiff(g.applied, expected).map((l) => `[crm] ${l}`),
  ]
}

/** The pending lists a plan prints, control first. */
export function pendingLines(g: GateOutcome): string[] {
  const one = (tag: string, pending: string[]): string[] => [pending.length === 0 ? `${tag}migrations to apply: none` : `${tag}migrations to apply (${pending.length}):`, ...pending.map((n) => `${tag}  ${n}`)]
  return g.control ? [...one('[control] ', g.control.pending), ...one('[crm] ', g.pending)] : one('', g.pending)
}

/** True when every configured database has nothing pending and the CRM tracker is exactly the shipped list. */
export const databasesCurrent = (g: GateOutcome, crmStatus: string): boolean => crmStatus === 'current' && (g.control === undefined || g.control.pending.length === 0)
