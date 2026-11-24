// The compatibility gate ([[OPS210]] D14, [[OPS231]]): read-only. It verifies the installed package, reads the settings and secrets, asks the live
// instance's `/health` and reads wrangler's migration tracker, and refuses or reports. It never runs a write command.
import { dnsRefusal, isDnsFailure } from './reach.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyRelease, type ReleaseManifest } from '../../../release/src/manifest.js'
import { formatMigrationDiff, parseTrackerOutput } from '../remote.js'
import { readSweepCounts, sweepCountLines, type SweepCounts } from '../sweep-counts.js'
import { withGeneratedConfig } from './config.js'
import { defaultSecretsPath, loadSecrets, type Secrets } from './secrets.js'
import { defaultSettingsPath, loadSettings } from './settings.js'
import { liveExtensionsOf, type LiveExtensions } from './extensions.js'
import { InstanceRefusal, type InstanceDeps, type InstanceSettings } from './types.js'

export interface GateOptions {
  envName: string
  settingsPath?: string
  secretsPath?: string
  /** `redeploy` ([[OPS487]] D1) skips (d) and (e) and every version comparison; `upgrade` and `status` (the default) run them. The only place the mode is read. */
  mode?: 'upgrade' | 'redeploy'
  /** `status` ([[CORE289]] P6): also read the repair sweep's pending counts (a control database only). */
  sweepCounts?: boolean
}
export interface GateOutcome {
  manifest: ReleaseManifest
  settings: InstanceSettings
  settingsPath: string
  live: { version: string; commit: string | null; extensions: LiveExtensions }
  /** `null`: no tracker table. */
  applied: string[] | null
  /** Names in the package not applied yet, in release order. */
  pending: string[]
  /** The control-plane database ([[OPS275]] D4): always present: every command but `setup` loads settings that record `control_d1` ([[CORE326]] P5). `applied` `null`: no tracker table; `pending` then lists every control migration. */
  control: {
    expected: string[]
    applied: string[] | null
    pending: string[] /** The sweep's pending counts when asked for; `null`: unreadable. */
    sweep?: SweepCounts | null
  }
  notes: string[]
  /** Migrations a tracker holds that the package does not know, per database ([[OPS487]] D3): `redeploy` leaves them and says so once; `upgrade` refuses them (D14 d). */
  unknown: { control: string[]; crm: string[] }
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

async function readHealth(
  url: string,
  deps: InstanceDeps,
): Promise<{ version: string; commit: string | null; extensions: LiveExtensions }> {
  let res: Response
  try {
    res = await deps.fetch(url, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
  } catch (e) {
    // [[OPS496]] D6: a name that does not resolve is said so; any other failure keeps `cannot reach`.
    if (isDnsFailure(e)) throw new InstanceRefusal(dnsRefusal(new URL(url).host))
    throw new InstanceRefusal(`cannot reach ${url}: ${e instanceof Error ? e.message : 'request failed'}`)
  }
  if (res.status !== 200)
    throw new InstanceRefusal(`${url} answered ${res.status}, not 200: is this the instance's api_host?`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  const version = (body as { version?: unknown } | null | undefined)?.version
  if (typeof version !== 'string')
    throw new InstanceRefusal(
      `${url} answered 200 but not with a Vibase health body (no version string): is this the instance's api_host?`,
    )
  const commit = (body as { commit?: unknown }).commit
  // [[CORE543]] P1: the attached extensions file as the live Worker reports it; an older build has no key, which counts as none.
  return { version, commit: typeof commit === 'string' ? commit : null, extensions: liveExtensionsOf(body) }
}

/** The whole child environment of a wrangler run: no other variable of the process, and the two Cloudflare values from the secrets. */
export function childEnv(deps: InstanceDeps, s: Secrets): Record<string, string> {
  const env: Record<string, string> = {
    CI: '1',
    WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_ACCOUNT_ID: s.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: s.CLOUDFLARE_API_TOKEN,
  }
  if (deps.env.PATH) env.PATH = deps.env.PATH
  if (deps.env.HOME) env.HOME = deps.env.HOME
  return env
}

/** wrangler's tracker table on the live database, read through the generated config. `null`: no tracker table. */
export function readTrackerAt(
  configPath: string,
  secrets: Secrets,
  deps: InstanceDeps,
  binding: 'DB' | 'CONTROL_DB' = 'DB',
): string[] | null {
  const r = deps.runWrangler(
    ['d1', 'execute', binding, '--remote', '--json', '--command', 'select name from d1_migrations', '-c', configPath],
    { cwd: join(configPath, '..'), env: childEnv(deps, secrets) },
  )
  try {
    return parseTrackerOutput(r.stdout)
  } catch (e) {
    const detail = (r.stderr.trim() || (e instanceof Error ? e.message : '')).slice(-400)
    throw new InstanceRefusal(`wrangler d1 execute failed (exit ${r.status ?? 'none'}): ${secrets.redact(detail)}`)
  }
}
/** Both trackers from one generated config, the control one first (settings always record one, [[CORE326]] P5). */
const readTrackers = (
  settings: InstanceSettings,
  secrets: Secrets,
  deps: InstanceDeps,
  withCounts = false,
): { control: string[] | null; crm: string[] | null; sweep?: SweepCounts | null } =>
  withGeneratedConfig({ packageDir: deps.packageDir, settings, tmpRoot: deps.tmpRoot }, (configPath) => {
    const control = readTrackerAt(configPath, secrets, deps, 'CONTROL_DB')
    const crm = readTrackerAt(configPath, secrets, deps, 'DB')
    // [[CORE289]] P6: two read-only SELECTs through the same generated config; a failed read is `unavailable`, never a refusal.
    const sweep = withCounts
      ? readSweepCounts((binding, sql) => {
          const r = deps.runWrangler(
            ['d1', 'execute', binding, '--remote', '--json', '--command', sql, '-c', configPath],
            { cwd: join(configPath, '..'), env: childEnv(deps, secrets) },
          )
          if (r.status !== 0) throw new Error('wrangler d1 execute failed')
          return r.stdout
        }, new Date())
      : undefined
    return { control, crm, ...(sweep === undefined ? {} : { sweep }) }
  })

export async function runGate(o: GateOptions, deps: InstanceDeps): Promise<GateOutcome> {
  // (a) the installed package is the release, before any network call or child process.
  const problems = verifyRelease(deps.packageDir)
  if (problems.length > 0)
    throw new InstanceRefusal(
      `the installed package does not match its release.json: ${problems.map((p) => `${p.path} (${p.kind})`).join(', ')}: reinstall it`,
    )
  const manifest = JSON.parse(readFileSync(join(deps.packageDir, 'release.json'), 'utf8')) as ReleaseManifest

  // (b) settings and secrets.
  const settingsPath = o.settingsPath ?? defaultSettingsPath(deps.env, deps.homedir, o.envName)
  const settings = loadSettings(settingsPath, o.envName)
  const secrets = loadSecrets(
    o.secretsPath ?? defaultSecretsPath(deps.env, deps.homedir, o.envName),
    deps.env,
    o.envName,
  )

  // (c) the live instance answers.
  const live = await readHealth(`https://${settings.api_host}/health`, deps)

  const trackers = readTrackers(settings, secrets, deps, o.sweepCounts === true)
  const applied = trackers.crm
  const known = manifest.migrations.map((m) => m.name)
  const controlKnown = (manifest.control_migrations ?? []).map((m) => m.name)
  const controlApplied = trackers.control
  const notes: string[] = []
  const unknown = {
    control: (controlApplied ?? []).filter((n) => !controlKnown.includes(n)),
    crm: (applied ?? []).filter((n) => !known.includes(n)),
  }
  // [[OPS487]] D1: `redeploy` puts this build on the instance whatever is live: no version or schema refusal, so (d) to (f) are for the other modes.
  if (o.mode !== 'redeploy') {
    // (d, control) the control database's applied migrations are all known too (shipped ⊇ applied).
    if (unknown.control.length > 0)
      throw new InstanceRefusal(
        `the control database has migrations this release does not know: install a newer release (${unknown.control.join(', ')})`,
      )
    // (d) the database's applied migrations are all known to this release.
    if (unknown.crm.length > 0)
      throw new InstanceRefusal(
        `the database has migrations this release does not know: install a newer release (${unknown.crm.join(', ')})`,
      )
    // (e) a newer semver live version refuses; (f) a non-semver one proceeds with a note.
    if (parseSemver(live.version) === null)
      notes.push(`live version "${live.version}" is not a release version (a source deploy?): continuing`)
    else if (parseSemver(manifest.version) !== null && compareSemver(live.version, manifest.version) > 0) {
      throw new InstanceRefusal(
        `the instance runs ${live.version} and this package is ${manifest.version}: the instance is newer, install a newer release, or run \`vibase-server redeploy --env ${settings.env}\` to deploy this older build over it`,
      )
    }
  }
  const have = new Set(applied ?? [])
  const haveControl = new Set(controlApplied ?? [])
  const control = {
    expected: controlKnown,
    applied: controlApplied,
    pending: controlKnown.filter((n) => !haveControl.has(n)),
    ...(trackers.sweep === undefined ? {} : { sweep: trackers.sweep }),
  }
  return {
    manifest,
    settings,
    settingsPath,
    live,
    applied,
    pending: known.filter((n) => !have.has(n)),
    control,
    notes,
    unknown,
    secrets,
  }
}

/** The shortest commit prefix that identifies a build ([[OPS487]] D4). */
const MIN_COMMIT_PREFIX = 7
/**
 * [[OPS487]] D4: two commits are the same build when both are known and one is a prefix of the other (a short and a full sha), at least 7 characters. A live `/health` with no commit
 * is never proven the same. A `-dirty` build ([[OPS210]]) and a clean one are different ([[OPS487]] 487.18), so the suffix must agree.
 */
export function sameCommit(live: string | null, pkg: string): boolean {
  if (live === null || live.length < MIN_COMMIT_PREFIX || pkg.length < MIN_COMMIT_PREFIX) return false
  if (live.endsWith('-dirty') !== pkg.endsWith('-dirty')) return false
  return live.startsWith(pkg) || pkg.startsWith(live)
}
/** True when the live instance reports the package's version but not its commit: the case `upgrade` and `status` must not call "nothing to do" ([[OPS487]] D4, D7). */
export const sameVersionDifferentBuild = (g: GateOutcome): boolean =>
  g.live.version === g.manifest.version && !sameCommit(g.live.commit, g.manifest.commit)
/** The two lines of D4's stop and D7's report. */
export const differentBuildLines = (g: GateOutcome): [string, string] => [
  `same version, different build: live ${g.live.commit ?? 'unknown'}, package ${g.manifest.commit}`,
  `run vibase-server redeploy --env ${g.settings.env} to deploy this build`,
]
/** [[OPS487]] D3: printed once by `redeploy`'s plan when either tracker holds migrations the package lacks. */
export const ROLLBACK_NOTE = 'note: rolling back code; the database schema is newer than this build and is not reversed'
export const hasUnknownMigrations = (g: GateOutcome): boolean => g.unknown.control.length + g.unknown.crm.length > 0

/** The tracker diff of each database ([[OPS275]] D14): each is prefixed `[control]` / `[crm]`. */
export function diffLines(g: GateOutcome): string[] {
  const expected = g.manifest.migrations.map((m) => m.name)
  return [
    ...formatMigrationDiff(g.control.applied ?? [], g.control.expected).map((l) => `[control] ${l}`),
    ...(g.control.applied === null ? ['[control]   (no d1_migrations table)'] : []),
    ...(g.control.sweep === undefined ? [] : sweepCountLines(g.control.sweep).map((l) => `[control] ${l}`)),
    ...formatMigrationDiff(g.applied, expected).map((l) => `[crm] ${l}`),
  ]
}

/** The pending lists a plan prints, control first. */
export function pendingLines(g: GateOutcome): string[] {
  const one = (tag: string, pending: string[]): string[] => [
    pending.length === 0 ? `${tag}migrations to apply: none` : `${tag}migrations to apply (${pending.length}):`,
    ...pending.map((n) => `${tag}  ${n}`),
  ]
  return [...one('[control] ', g.control.pending), ...one('[crm] ', g.pending)]
}

/** True when every configured database has nothing pending and the CRM tracker is exactly the shipped list. */
export const databasesCurrent = (g: GateOutcome, crmStatus: string): boolean =>
  crmStatus === 'current' && g.control.pending.length === 0
