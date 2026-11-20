// `vibase-server upgrade [--dry-run] --env <name>` and `vibase-server redeploy [--dry-run] --env <name>` ([[OPS210]] D13, D15, [[OPS234]], [[OPS487]]): from the installed release package, migrate, deploy the
// package's own prebuilt Worker with `--no-bundle`, verify `/health` and run the key-less smoke. One runner, two modes: `upgrade` moves forward by version and stops on a same-version, different build;
// `redeploy` puts this build on the instance whatever is live (a new build of the same version, the same build again, an older package: the rollback) and applies only the migrations the instance lacks.
// Every wrangler call is the package's own wrangler on the generated config (never `--env`, never `pnpm exec`); the instance is only ever told what is in the package.
import { parseArgs } from 'node:util'
import { requireConfirm, statusOf } from '../remote.js'
import { keylessChecks } from '../smoke-checks.js'
import { withGeneratedConfig } from './config.js'
import {
  childEnv,
  databasesCurrent,
  differentBuildLines,
  diffLines,
  hasUnknownMigrations,
  pendingLines,
  readTrackerAt,
  ROLLBACK_NOTE,
  runGate,
  sameCommit,
  sameVersionDifferentBuild,
} from './gate.js'
import { dnsHint, waitLine } from '../setup/verify-better-auth.js'
import { isRefusal, InstanceRefusal, type InstanceDeps } from './types.js'

/** Exit codes ([[OPS234]] P2): 0 done or nothing to do; 2 refused before any remote write; 3 failed after a remote write began. */
export const EXIT_DONE = 0
export const EXIT_REFUSED = 2
export const EXIT_FAILED = 3

/** The verify loop's bound and interval (the same as `setup`'s, [[OPS65]] D21). */
export const VERIFY_BOUND_MS = 300_000
export const VERIFY_INTERVAL_MS = 10_000

export type DeployMode = 'upgrade' | 'redeploy'
const usageOf = (mode: DeployMode): string =>
  `usage: vibase-server ${mode} --env <name> [--dry-run] [--settings <path>] [--secrets-file <path>]`

/** The exact argument list of the deploy: the release's own version and commit stamped as vars, no bundling. `check.ts` hands the same list to the installed wrangler. */
export const deployArgs = (version: string, commit: string, configPath: string): string[] => [
  'deploy',
  '--no-bundle',
  '--var',
  `VERSION:${version}`,
  '--var',
  `COMMIT:${commit}`,
  '-c',
  configPath,
]
export const migrateArgs = (configPath: string, binding: 'DB' | 'CONTROL_DB' = 'DB'): string[] => [
  'd1',
  'migrations',
  'apply',
  binding,
  '--remote',
  '-c',
  configPath,
]

/** A failure after the first remote write began: names the step. */
class StepFailure extends Error {
  constructor(
    readonly step: string,
    detail: string,
  ) {
    super(detail)
  }
}

export const runUpgrade = (argv: string[], deps: InstanceDeps): Promise<number> => runDeploy('upgrade', argv, deps)
export const runRedeploy = (argv: string[], deps: InstanceDeps): Promise<number> => runDeploy('redeploy', argv, deps)

async function runDeploy(mode: DeployMode, argv: string[], deps: InstanceDeps): Promise<number> {
  const USAGE = usageOf(mode)
  const redeploy = mode === 'redeploy'
  let began = false
  let step: string = mode
  let redact = (t: string): string => t
  try {
    let values: { env?: string; settings?: string; 'secrets-file'?: string; 'dry-run'?: boolean }
    // [[OPS487]] D6: `upgrade --rollback` was replaced by `redeploy`; the flag is named, not left to parseArgs' generic message.
    if (!redeploy && argv.includes('--rollback'))
      throw new InstanceRefusal(`--rollback was replaced by vibase-server redeploy; ${USAGE}`)
    try {
      values = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: false,
        options: {
          env: { type: 'string' },
          settings: { type: 'string' },
          'secrets-file': { type: 'string' },
          'dry-run': { type: 'boolean' },
        },
      }).values
    } catch (e) {
      throw new InstanceRefusal(`${e instanceof Error ? e.message : 'bad arguments'}; ${USAGE}`)
    }
    if (!values.env) throw new InstanceRefusal(`--env <name> is required; ${USAGE}`)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(values.env))
      throw new InstanceRefusal(`--env ${values.env} is not an environment name (lowercase letters, digits and dashes)`)

    const g = await runGate(
      { envName: values.env, settingsPath: values.settings, secretsPath: values['secrets-file'], mode },
      deps,
    )
    redact = g.secrets.redact
    const { manifest, settings } = g
    const expected = manifest.migrations.map((m) => m.name)
    const url = `https://${settings.api_host}`

    deps.out(
      `package: vibase-server/${manifest.version} (${manifest.commit}), ${Object.keys(manifest.files).length} files verified`,
    )
    deps.out(`instance: ${settings.env} at ${url} (worker ${settings.worker}, settings ${g.settingsPath})`)
    deps.out(`live: version ${g.live.version}${g.live.commit ? `, commit ${g.live.commit}` : ''}`)
    for (const n of g.notes) deps.out(`note: ${n}`)
    for (const l of diffLines(g)) deps.out(l)

    if (redeploy) {
      deps.out(
        `plan: redeploy, live ${g.live.version} (${g.live.commit ?? 'unknown'}) -> package ${manifest.version} (${manifest.commit})`,
      )
      for (const l of pendingLines(g)) deps.out(l)
      if (hasUnknownMigrations(g)) deps.out(ROLLBACK_NOTE)
    } else {
      // [[OPS487]] D4: before the nothing-to-do claim and before CONFIRM_REMOTE, whatever the migrations' state.
      if (sameVersionDifferentBuild(g)) throw new InstanceRefusal(differentBuildLines(g).join('\n'))
      if (g.live.version === manifest.version && databasesCurrent(g, statusOf(g.applied, expected))) {
        deps.out(`plan: nothing to do, the instance is at ${manifest.version}`)
        return EXIT_DONE
      }
      deps.out(`plan: live ${g.live.version} -> package ${manifest.version}`)
      for (const l of pendingLines(g)) deps.out(l)
    }
    if (values['dry-run']) {
      deps.out('dry run: nothing was changed')
      return EXIT_DONE
    }
    requireConfirm(deps.env as NodeJS.ProcessEnv)

    // From here on the instance may change: a failure is exit 3 and names its step.
    began = true
    const wrangler = (configPath: string, args: string[]) =>
      deps.runWrangler(args, { cwd: configPath.replace(/[/\\][^/\\]*$/, ''), env: childEnv(deps, g.secrets) })
    const tail = (r: { stdout: string; stderr: string }) => redact((r.stderr.trim() || r.stdout.trim()).slice(-400))
    withGeneratedConfig({ packageDir: deps.packageDir, settings, tmpRoot: deps.tmpRoot }, (configPath) => {
      // Control first, then CRM ([[OPS275]] D14): each is applied, then its tracker must hold every shipped migration before the next step.
      // `redeploy` ([[OPS487]] D2) touches only a database with something pending, and accepts `ahead` (unknown migrations are left as they are).
      const targets: { binding: 'DB' | 'CONTROL_DB'; label: string; expected: string[]; pending: string[] }[] = [
        { binding: 'CONTROL_DB' as const, label: ' control', expected: g.control.expected, pending: g.control.pending },
        { binding: 'DB' as const, label: ' crm', expected, pending: g.pending },
      ]
      for (const t of targets) {
        if (redeploy && t.pending.length === 0) continue
        step = `migrate${t.label}`
        const m = wrangler(configPath, migrateArgs(configPath, t.binding))
        if (m.status !== 0)
          throw new StepFailure(step, `wrangler d1 migrations apply failed (exit ${m.status ?? 'none'}): ${tail(m)}`)
        deps.out(`${step}: applied`)
        step = `tracker check${t.label}`
        let after: string[] | null
        try {
          after = readTrackerAt(configPath, g.secrets, deps, t.binding)
        } catch (e) {
          throw new StepFailure(step, e instanceof Error ? e.message : 'unreadable')
        }
        const status = statusOf(after, t.expected)
        if (!(status === 'current' || (redeploy && status === 'ahead')))
          throw new StepFailure(
            step,
            `after the migrations the ${t.binding === 'DB' ? '' : 'control '}database is ${status}, not ${redeploy ? 'current or ahead' : 'current'}: not deploying`,
          )
        deps.out(`${step}: ${status}`)
      }
      step = 'deploy'
      const d = wrangler(configPath, deployArgs(manifest.version, manifest.commit, configPath))
      if (d.status !== 0)
        throw new StepFailure('deploy', `wrangler deploy failed (exit ${d.status ?? 'none'}): ${tail(d)}`)
      deps.out(`deploy: ${manifest.version} uploaded`)
    })

    step = 'verify'
    const accept = redeploy ? ['ahead', 'current'] : ['current']
    const seen = await verify(url, manifest.version, accept, deps, undefined, deps.out, manifest.commit)
    if (seen !== null)
      throw new StepFailure(
        'verify',
        `${url}/health did not show version ${manifest.version} (commit ${manifest.commit}) with migrations ${accept.join(' or ')} within ${VERIFY_BOUND_MS / 1000}s (${seen})${seen === 'no answer' ? `; ${dnsHint(url, `vibase-server status --env ${settings.env}`)}` : ''}`,
      )
    deps.out(`verify: ${url}/health is at ${manifest.version}`)

    step = 'smoke'
    const results = await keylessChecks(url, manifest.version, accept, deps.fetch)
    for (const r of results)
      deps.out(
        `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok || r.detail === undefined ? '' : ` ${JSON.stringify(r.detail)}`}`,
      )
    const bad = results.filter((r) => !r.ok)
    if (bad.length > 0)
      throw new StepFailure('smoke', `${bad.length} check(s) failed: ${bad.map((b) => b.name).join('; ')}`)
    deps.out(`${redeploy ? 'redeployed' : 'upgraded'} ${settings.env} to ${manifest.version}`)
    return EXIT_DONE
  } catch (e) {
    if (!began) {
      if (!isRefusal(e)) throw e
      deps.err(`vibase-server ${mode}: ${e.message}`)
      return EXIT_REFUSED
    }
    const detail = e instanceof StepFailure ? e.message : e instanceof Error ? redact(e.message) : 'failed'
    deps.err(
      `vibase-server ${mode}: ${e instanceof StepFailure ? e.step : step} failed: ${detail} (the instance may be partly ${redeploy ? 'deployed' : 'upgraded'}: run \`vibase-server status\` to see where it is, then run ${mode} again)`,
    )
    return EXIT_FAILED
  }
}

/** Polls `/health` until the package's version shows with an accepted migrations status, and its commit too when `commit` is given and `/health` reports one ([[OPS487]] D5); bounded, on the injected clock. `null` when it did, else what was last seen. */
export async function verify(
  url: string,
  version: string,
  accept: readonly string[],
  deps: InstanceDeps,
  startedAt?: number,
  /** One line per poll ([[GH442]] item 1). */
  progress?: (line: string) => void,
  /** The package's commit. A `/health` that reports none is judged on the version alone, as before. */
  commit?: string,
): Promise<string | null> {
  const read = async (): Promise<{ version?: string; migrations?: string; commit?: string } | null> => {
    try {
      const res = await deps.fetch(`${url}/health`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status !== 200) return null
      const j = (await res.json()) as { version?: unknown; commit?: unknown; migrations?: { status?: unknown } }
      return {
        commit: typeof j.commit === 'string' ? j.commit : undefined,
        version: typeof j.version === 'string' ? j.version : undefined,
        migrations: typeof j.migrations?.status === 'string' ? j.migrations.status : undefined,
      }
    } catch {
      return null
    }
  }
  const ready = (h: { version?: string; migrations?: string; commit?: string } | null) =>
    h !== null &&
    h.version === version &&
    (commit === undefined || h.commit === undefined || sameCommit(h.commit, commit)) &&
    h.migrations !== undefined &&
    accept.includes(h.migrations)
  let h = await read()
  // `setup` passes the instant its verify step began, so the health wait and discovery share one bound ([[OPS308]] P2); `upgrade` measures from here as before.
  const start = startedAt ?? deps.now()
  while (!ready(h) && deps.now() - start < VERIFY_BOUND_MS) {
    progress?.(waitLine(deps.now() - start))
    await deps.sleep(VERIFY_INTERVAL_MS)
    h = await read()
  }
  return ready(h)
    ? null
    : h === null
      ? 'no answer'
      : `version ${h.version ?? '?'}, commit ${h.commit ?? 'none'}, migrations ${h.migrations ?? '?'}`
}
