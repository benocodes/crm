// `vibase-server upgrade [--dry-run] [--rollback] --env <name>` ([[OPS210]] D13, D15, D16, [[OPS234]]): from the installed release package, migrate, deploy the
// package's own prebuilt Worker with `--no-bundle`, verify `/health` and run the key-less smoke. `--rollback` deploys an older package's Worker without any migration.
// Every wrangler call is the package's own wrangler on the generated config (never `--env`, never `pnpm exec`); the instance is only ever told what is in the package.
import { parseArgs } from 'node:util'
import { requireConfirm, statusOf } from '../remote.js'
import { keylessChecks } from '../smoke-checks.js'
import { withGeneratedConfig } from './config.js'
import { childEnv, databasesCurrent, diffLines, pendingLines, readTrackerAt, runGate } from './gate.js'
import { isRefusal, InstanceRefusal, type InstanceDeps } from './types.js'

/** Exit codes ([[OPS234]] P2): 0 done or nothing to do; 2 refused before any remote write; 3 failed after a remote write began. */
export const EXIT_DONE = 0
export const EXIT_REFUSED = 2
export const EXIT_FAILED = 3

/** The verify loop's bound and interval (the same as `setup`'s, [[OPS65]] D21). */
export const VERIFY_BOUND_MS = 300_000
export const VERIFY_INTERVAL_MS = 10_000

const USAGE = 'usage: vibase-server upgrade --env <name> [--dry-run] [--rollback] [--settings <path>] [--secrets-file <path>]'

/** The exact argument list of the deploy: the release's own version and commit stamped as vars, no bundling. `check.ts` hands the same list to the installed wrangler. */
export const deployArgs = (version: string, commit: string, configPath: string): string[] => ['deploy', '--no-bundle', '--var', `VERSION:${version}`, '--var', `COMMIT:${commit}`, '-c', configPath]
export const migrateArgs = (configPath: string, binding: 'DB' | 'CONTROL_DB' = 'DB'): string[] => ['d1', 'migrations', 'apply', binding, '--remote', '-c', configPath]

/** A failure after the first remote write began: names the step. */
class StepFailure extends Error {
  constructor(readonly step: string, detail: string) {
    super(detail)
  }
}

export async function runUpgrade(argv: string[], deps: InstanceDeps): Promise<number> {
  let began = false
  let step = 'upgrade'
  let redact = (t: string): string => t
  try {
    let values: { env?: string; settings?: string; 'secrets-file'?: string; 'dry-run'?: boolean; rollback?: boolean }
    try {
      values = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { env: { type: 'string' }, settings: { type: 'string' }, 'secrets-file': { type: 'string' }, 'dry-run': { type: 'boolean' }, rollback: { type: 'boolean' } } }).values
    } catch (e) {
      throw new InstanceRefusal(`${e instanceof Error ? e.message : 'bad arguments'}; ${USAGE}`)
    }
    if (!values.env) throw new InstanceRefusal(`--env <name> is required; ${USAGE}`)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(values.env)) throw new InstanceRefusal(`--env ${values.env} is not an environment name (lowercase letters, digits and dashes)`)
    const rollback = values.rollback === true

    const g = await runGate({ envName: values.env, settingsPath: values.settings, secretsPath: values['secrets-file'], rollback }, deps)
    redact = g.secrets.redact
    const { manifest, settings } = g
    const expected = manifest.migrations.map((m) => m.name)
    const url = `https://${settings.api_host}`

    deps.out(`package: vibase-server/${manifest.version} (${manifest.commit}), ${Object.keys(manifest.files).length} files verified`)
    deps.out(`instance: ${settings.env} at ${url} (worker ${settings.worker}, settings ${g.settingsPath})`)
    deps.out(`live: version ${g.live.version}${g.live.commit ? `, commit ${g.live.commit}` : ''}`)
    for (const n of g.notes) deps.out(`note: ${n}`)
    for (const l of diffLines(g)) deps.out(l)

    if (!rollback && g.live.version === manifest.version && databasesCurrent(g, statusOf(g.applied, expected))) {
      deps.out(`plan: nothing to do, the instance is at ${manifest.version}`)
      return EXIT_DONE
    }
    if (rollback) {
      deps.out(`plan: rollback, live ${g.live.version} -> package ${manifest.version}: deploy this package's Worker; no migration runs`)
      deps.out('the database stays at its newer schema; the older Worker runs on it (migrations: ahead)')
    } else {
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
    const wrangler = (configPath: string, args: string[]) => deps.runWrangler(args, { cwd: configPath.replace(/[/\\][^/\\]*$/, ''), env: childEnv(deps, g.secrets) })
    const tail = (r: { stdout: string; stderr: string }) => redact((r.stderr.trim() || r.stdout.trim()).slice(-400))
    withGeneratedConfig({ packageDir: deps.packageDir, settings, tmpRoot: deps.tmpRoot }, (configPath) => {
      if (!rollback) {
        // Control first, then CRM ([[OPS275]] D14): each is applied, then its tracker must read exactly the shipped list before the next step.
        const targets: { binding: 'DB' | 'CONTROL_DB'; label: string; expected: string[] }[] = [
          ...(g.control ? [{ binding: 'CONTROL_DB' as const, label: ' control', expected: g.control.expected }] : []),
          { binding: 'DB' as const, label: g.control ? ' crm' : '', expected },
        ]
        for (const t of targets) {
          step = `migrate${t.label}`
          const m = wrangler(configPath, migrateArgs(configPath, t.binding))
          if (m.status !== 0) throw new StepFailure(step, `wrangler d1 migrations apply failed (exit ${m.status ?? 'none'}): ${tail(m)}`)
          deps.out(`${step}: applied`)
          step = `tracker check${t.label}`
          let after: string[] | null
          try {
            after = readTrackerAt(configPath, g.secrets, deps, t.binding)
          } catch (e) {
            throw new StepFailure(step, e instanceof Error ? e.message : 'unreadable')
          }
          const status = statusOf(after, t.expected)
          if (status !== 'current') throw new StepFailure(step, `after the migrations the ${t.binding === 'DB' ? '' : 'control '}database is ${status}, not current: not deploying`)
          deps.out(`${step}: current`)
        }
      }
      step = 'deploy'
      const d = wrangler(configPath, deployArgs(manifest.version, manifest.commit, configPath))
      if (d.status !== 0) throw new StepFailure('deploy', `wrangler deploy failed (exit ${d.status ?? 'none'}): ${tail(d)}`)
      deps.out(`deploy: ${manifest.version} uploaded`)
    })

    step = 'verify'
    const accept = rollback ? ['ahead', 'current'] : ['current']
    const seen = await verify(url, manifest.version, accept, deps)
    if (seen !== null) throw new StepFailure('verify', `${url}/health did not show version ${manifest.version} with migrations ${accept.join(' or ')} within ${VERIFY_BOUND_MS / 1000}s (${seen})`)
    deps.out(`verify: ${url}/health is at ${manifest.version}`)

    step = 'smoke'
    const results = await keylessChecks(url, manifest.version, accept, deps.fetch)
    for (const r of results) deps.out(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok || r.detail === undefined ? '' : ` ${JSON.stringify(r.detail)}`}`)
    const bad = results.filter((r) => !r.ok)
    if (bad.length > 0) throw new StepFailure('smoke', `${bad.length} check(s) failed: ${bad.map((b) => b.name).join('; ')}`)
    deps.out(`${rollback ? 'rolled back' : 'upgraded'} ${settings.env} to ${manifest.version}`)
    return EXIT_DONE
  } catch (e) {
    if (!began) {
      if (!isRefusal(e)) throw e
      deps.err(`vibase-server upgrade: ${e.message}`)
      return EXIT_REFUSED
    }
    const detail = e instanceof StepFailure ? e.message : e instanceof Error ? redact(e.message) : 'failed'
    deps.err(`vibase-server upgrade: ${e instanceof StepFailure ? e.step : step} failed: ${detail} (the instance may be partly upgraded: run \`vibase-server status\` to see where it is, then run upgrade again)`)
    return EXIT_FAILED
  }
}

/** Polls `/health` until the package's version shows with an accepted migrations status; bounded, on the injected clock. `null` when it did, else what was last seen. */
export async function verify(url: string, version: string, accept: readonly string[], deps: InstanceDeps): Promise<string | null> {
  const read = async (): Promise<{ version?: string; migrations?: string } | null> => {
    try {
      const res = await deps.fetch(`${url}/health`, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      if (res.status !== 200) return null
      const j = (await res.json()) as { version?: unknown; migrations?: { status?: unknown } }
      return { version: typeof j.version === 'string' ? j.version : undefined, migrations: typeof j.migrations?.status === 'string' ? j.migrations.status : undefined }
    } catch {
      return null
    }
  }
  const ready = (h: { version?: string; migrations?: string } | null) => h !== null && h.version === version && h.migrations !== undefined && accept.includes(h.migrations)
  let h = await read()
  const start = deps.now()
  while (!ready(h) && deps.now() - start < VERIFY_BOUND_MS) {
    await deps.sleep(VERIFY_INTERVAL_MS)
    h = await read()
  }
  return ready(h) ? null : h === null ? 'no answer' : `version ${h.version ?? '?'}, migrations ${h.migrations ?? '?'}`
}
