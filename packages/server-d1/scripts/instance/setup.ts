// `vibase-server setup --env <name> --api-host <host> [flags]` ([[OPS210]] D17, D18, [[OPS232]] P1-P6): from an installed release package, one guarded and idempotent
// run from nothing (or from an instance deployed from source) to a migrated, bootstrapped, deployed, verified instance. The steps are [[OPS65]]'s (D11 order) over the
// settings and secrets files; `config:write` writes the settings file and the run goes on. Exit 0: done, or the dry run is complete; 2: refused before the first step;
// 3: a step failed (named; no later step ran). Nothing here reads a repo path or the process environment.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyRelease, type ReleaseManifest } from '../../../release/src/manifest.js'
import { requireConfirm, resolveTarget } from '../remote.js'
import { applyRecordedNames } from '../setup/names.js'
import { loadClerkKeys } from '../setup/clerk-keys.js'
import { GMAIL_SECRET_NAMES, GMAIL_VAR_NAMES, loadGmail } from '../setup/gmail.js'
import { CLERK_ONLY_STEPS, STEP_NAMES, type EnvFileProbe, type StepResult } from '../setup/types.js'
import { compareSemver, parseSemver } from './gate.js'
import { defaultSecretsPath, loadSecrets } from './secrets.js'
import { defaultSettingsPath, loadSettings } from './settings.js'
import { parseInstanceSetupArgs } from './setup-args.js'
import { STEPS, type SetupCtx } from './setup-steps.js'
import { InstanceRefusal, isRefusal, type InstanceDeps } from './types.js'

export const EXIT_DONE = 0
export const EXIT_REFUSED = 2
export const EXIT_FAILED = 3

const USAGE = 'usage: vibase-server setup --env <name> --api-host <host> [--auth clerk|none] [--owner-email <e>] [--settings <path>] [--secrets-file <path>] [--dry-run] [flags]'
const row = (r: StepResult) => `${r.status.padEnd(7)} ${r.step.padEnd(17)} ${r.detail}`

/** A step's failure that is a refusal (an unresolvable wrangler) before anything was written is a refusal, not a failed step. */
const refusalOf = (e: unknown, ctx: SetupCtx): Error | null => (isRefusal(e) && !ctx.wrote ? (e as Error) : null)

export async function runSetup(argv: string[], deps: InstanceDeps): Promise<number> {
  // Everything printed goes through the secrets' redaction, and through the operator key once it exists.
  const extraMasks: string[] = []
  let redactSecrets = (t: string): string => t
  const redact = (t: string): string => extraMasks.reduce((s, v) => s.split(v).join('***'), redactSecrets(t))
  const out = (l: string) => deps.out(redact(l))
  const err = (l: string) => deps.err(redact(l))
  let ctx: SetupCtx
  let manifest: ReleaseManifest
  try {
    let parsed: ReturnType<typeof parseInstanceSetupArgs>
    try {
      parsed = parseInstanceSetupArgs(argv)
    } catch (e) {
      if (!isRefusal(e)) throw e
      throw new InstanceRefusal(`${(e as Error).message}; ${USAGE}`)
    }
    const { opts: derived } = parsed

    // (a) the installed package is the release, before any network call or child process.
    const problems = verifyRelease(deps.packageDir)
    if (problems.length > 0) throw new InstanceRefusal(`the installed package does not match its release.json: ${problems.map((p) => `${p.path} (${p.kind})`).join(', ')}: reinstall it`)
    manifest = JSON.parse(readFileSync(join(deps.packageDir, 'release.json'), 'utf8')) as ReleaseManifest

    // (b) the secrets file (D10: mode refusal) and the settings file, if there is one.
    const secretsPath = parsed.secretsPath ?? defaultSecretsPath(deps.env, deps.homedir, derived.env)
    const secrets = loadSecrets(secretsPath, deps.env)
    redactSecrets = secrets.redact
    const settingsPath = parsed.settingsPath ?? defaultSettingsPath(deps.env, deps.homedir, derived.env)
    const existing = existsSync(settingsPath) ? loadSettings(settingsPath, derived.env) : null
    // [[OPS276]]: the names the settings file records win over the derivation; a name flag that differs is refused before any step.
    const opts = existing ? applyRecordedNames(derived, { workerName: existing.worker, d1Name: existing.d1.name, r2Name: existing.r2_bucket }, settingsPath) : derived
    // The target guard of every remote command ([[OPS4]] C4): a Worker named `vault` is the local-only top level.
    resolveTarget({ name: opts.workerName, d1_databases: [{ binding: 'DB', database_id: existing?.d1.id ?? '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b', remote: true }] }, opts.env)

    // The Clerk and Gmail values come from the secrets file, judged by the source path's own rules.
    const probe: EnvFileProbe = { display: secretsPath, status: 'ok', text: secrets.text }
    const keys = opts.auth === 'clerk' ? loadClerkKeys(opts, { probeEnvFile: () => probe }, probe) : undefined
    const gmail = loadGmail(opts, probe)
    if (!opts.dryRun) requireConfirm(deps.env as NodeJS.ProcessEnv)

    // (c) P2: a live instance that is a newer release refuses before any write; no answer or a non-semver version (a source deploy) proceeds.
    const live = await readLiveVersion(opts.apiHost, deps)
    if (live !== null && parseSemver(live) !== null && parseSemver(manifest.version) !== null && compareSemver(live, manifest.version) > 0) {
      throw new InstanceRefusal(`the instance runs ${live} and this package is ${manifest.version}: the instance is newer, install a newer release (or run an older package's \`vibase-server upgrade --rollback\`)`)
    }
    ctx = {
      opts,
      deps: { ...deps, readConfigText: () => JSON.stringify({ env: { [opts.env]: { vars: existing?.vars ?? {} } } }) },
      manifest,
      secrets,
      creds: { accountId: secrets.CLOUDFLARE_ACCOUNT_ID, apiToken: secrets.CLOUDFLARE_API_TOKEN },
      settingsPath,
      secretsPath,
      existing,
      current: existing ?? undefined,
      keys,
      gmail,
      pending: false,
      wrote: false,
      extraMasks,
    }
    if (live !== null && parseSemver(live) === null) out(`note: live version "${live}" is not a release version (a source deploy?): continuing`)
  } catch (e) {
    if (!isRefusal(e)) throw e
    err(`vibase-server setup: ${(e as Error).message}`)
    return EXIT_REFUSED
  }

  const { opts } = ctx
  const say = out
  const say2 = err
  say(`package: vibase-server/${manifest.version} (${manifest.commit}), ${Object.keys(manifest.files).length} files verified`)
  say(`setup: env ${opts.env}, auth ${opts.auth}, api host ${opts.apiHost}, settings ${ctx.settingsPath}${opts.dryRun ? ' (dry run: reads only)' : ''}`)
  if (ctx.keys) say(`clerk instance: ${ctx.keys.kind}${ctx.keys.kind === 'development' ? " (warning: a development instance is a test instance, with Clerk's user cap and dev-browser handshake)" : ''}, issuer ${ctx.keys.issuer}, keys from ${ctx.secretsPath}`)
  say(
    ctx.gmail
      ? `gmail: on, from ${ctx.secretsPath}: secrets ${GMAIL_SECRET_NAMES.join(', ')}; vars ${Object.keys(ctx.gmail.vars).sort((a, b) => GMAIL_VAR_NAMES.indexOf(a as never) - GMAIL_VAR_NAMES.indexOf(b as never)).join(', ')}`
      : 'gmail: skipped (none of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_STATE_SECRET, CREDENTIALS_KEY in the secrets file)',
  )
  const selected = STEP_NAMES.filter((s) => (opts.only === undefined || opts.only.includes(s)) && (opts.auth === 'clerk' || !CLERK_ONLY_STEPS.includes(s)))
  const results: StepResult[] = []
  for (const name of selected) {
    let r: StepResult
    try {
      r = await STEPS[name](ctx)
    } catch (e) {
      const refusal = refusalOf(e, ctx)
      if (refusal) {
        say2(`vibase-server setup: ${refusal.message}`)
        return EXIT_REFUSED
      }
      r = { step: name, status: 'fail', detail: redact(e instanceof Error ? e.message : 'failed') }
    }
    if (!opts.dryRun && (r.status === 'create' || r.status === 'update')) ctx.wrote = true
    results.push(r)
    say(row(r))
    for (const l of r.lines ?? []) say(`        ${l}`)
    if (r.status === 'fail') break
  }
  const manual = [...results.filter((r) => r.status === 'manual').map((r) => `${r.step}: ${r.detail}`), ...results.flatMap((r) => r.manual ?? [])]
  if (manual.length > 0) {
    say('manual:')
    for (const m of manual) say(`  ${m}`)
  }
  const failed = results.find((r) => r.status === 'fail')
  if (failed) {
    say2(`vibase-server setup: ${failed.step} failed: ${failed.detail}`)
    return EXIT_FAILED
  }
  say(opts.dryRun ? 'setup: dry run complete, nothing was changed' : 'setup: done')
  return EXIT_DONE
}

/** The live `/health` version, or `null` when it does not answer 200 with one. */
async function readLiveVersion(apiHost: string, deps: InstanceDeps): Promise<string | null> {
  try {
    const res = await deps.fetch(`https://${apiHost}/health`, { redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (res.status !== 200) return null
    const v = ((await res.json()) as { version?: unknown }).version
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}
