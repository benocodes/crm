// `setup:remote` ([[OPS65]] D6): parse and guard first (no subprocess, no network), then the steps in D11 order.
import { RemoteRefusal, requireConfirm } from '../remote.js'
import { parse } from 'jsonc-parser'
import { parseSetupArgs } from './args.js'
import { applyRecordedNames, type RecordedNames } from './names.js'
import { loadClerkKeys } from './clerk-keys.js'
import { GMAIL_SECRET_NAMES, GMAIL_VAR_NAMES, loadGmail } from './gmail.js'
import { STEPS, type Ctx } from './steps.js'
import { CLERK_ONLY_STEPS, STEP_NAMES, type SetupDeps, type StepResult } from './types.js'

export interface SetupOutcome {
  exitCode: number
  results: StepResult[]
  /** True when a config write ended the run early ([[OPS65]] D10). */
  stoppedAfterConfigWrite: boolean
}

const row = (r: StepResult) => `${r.status.padEnd(7)} ${r.step.padEnd(17)} ${r.detail}`

export async function runSetup(argv: string[], procEnv: NodeJS.ProcessEnv, deps: SetupDeps): Promise<SetupOutcome> {
  let ctx: Ctx
  try {
    const parsed = parseSetupArgs(argv)
    // [[OPS276]]: the names the env block already records win over the derivation, before any step creates anything.
    const opts = applyRecordedNames(parsed, recordedNames(readOrEmpty(deps), parsed.env), 'wrangler.jsonc')
    if (!opts.dryRun) requireConfirm(procEnv)
    // The Clerk keys come from the instance's own file, before any request; the process environment is never read for them (D34).
    // The same file also holds the Gmail group ([[OPS150]]), on `--auth none` too: one probe, the same refusals.
    const probe = deps.probeEnvFile(opts.clerkEnvFile, opts.env)
    const keys = opts.auth === 'clerk' ? loadClerkKeys(opts, deps, probe) : undefined
    const gmail = loadGmail(opts, probe)
    ctx = { opts, deps, creds: deps.loadEnv(), pending: false, keys, gmail }
  } catch (err) {
    if (!(err instanceof RemoteRefusal)) throw err
    deps.log(`setup: ${err.message}`)
    return { exitCode: 1, results: [], stoppedAfterConfigWrite: false }
  }
  const { opts } = ctx
  const selected = STEP_NAMES.filter((s) => (opts.only === undefined || opts.only.includes(s)) && (opts.auth === 'clerk' || !CLERK_ONLY_STEPS.includes(s)) && !(s === 'secrets' && opts.only === undefined && opts.auth === 'none' && !ctx.gmail))
  deps.log(`setup:remote env ${opts.env}, auth ${opts.auth}, api host ${opts.apiHost}${opts.dryRun ? ' (dry run: reads only)' : ''}`)
  if (ctx.keys) {
    const k = ctx.keys
    deps.log(`clerk instance: ${k.kind}${k.kind === 'development' ? ' (warning: a development instance is a test instance, with Clerk\'s user cap and dev-browser handshake)' : ''}, issuer ${k.issuer}, keys from ${k.file}`)
  }
  deps.log(
    ctx.gmail
      ? `gmail: on, from ${ctx.gmail.file}: secrets ${GMAIL_SECRET_NAMES.join(', ')}; vars ${Object.keys(ctx.gmail.vars).sort((a, b) => GMAIL_VAR_NAMES.indexOf(a as never) - GMAIL_VAR_NAMES.indexOf(b as never)).join(', ')}`
      : 'gmail: skipped (none of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_STATE_SECRET, CREDENTIALS_KEY in the env file)',
  )
  const results: StepResult[] = []
  for (const name of selected) {
    let r: StepResult
    try {
      r = await STEPS[name](ctx)
    } catch (err) {
      r = { step: name, status: 'fail', detail: err instanceof Error ? err.message : 'failed' }
    }
    results.push(r)
    deps.log(row(r))
    for (const l of r.lines ?? []) deps.log(`        ${l}`)
    if (r.status === 'fail' || ctx.stop) break
  }
  const manual = [...results.filter((r) => r.status === 'manual').map((r) => `${r.step}: ${r.detail}`), ...results.flatMap((r) => r.manual ?? [])]
  if (manual.length > 0) {
    deps.log('manual:')
    for (const m of manual) deps.log(`  ${m}`)
  }
  const failed = results.some((r) => r.status === 'fail')
  deps.log(failed ? 'setup: failed' : ctx.stop ? 'setup: stopped after writing wrangler.jsonc; commit it and re-run' : opts.dryRun ? 'setup: dry run complete, nothing was changed' : 'setup: done')
  return { exitCode: failed ? 1 : 0, results, stoppedAfterConfigWrite: ctx.stop === true }
}

/** The names `env.<env>` in wrangler.jsonc records: the Worker `name`, the `DB` database and the `BODIES` bucket; absent kinds are not recorded. */
export function recordedNames(configText: string, env: string): RecordedNames {
  const root = parse(configText, [], { allowTrailingComma: true }) as { env?: Record<string, any> } | undefined
  const block = root?.env?.[env]
  if (typeof block !== 'object' || block === null) return {}
  const named = (list: unknown, key: string, id: string, field: string): string | undefined => {
    const e = Array.isArray(list) ? list.find((x) => x && x[key] === id) : undefined
    return typeof e?.[field] === 'string' ? e[field] : undefined
  }
  return {
    workerName: typeof block.name === 'string' ? block.name : undefined,
    d1Name: named(block.d1_databases, 'binding', 'DB', 'database_name'),
    r2Name: named(block.r2_buckets, 'binding', 'BODIES', 'bucket_name'),
  }
}

/** A config that cannot be read is no record: `config:write` reports the read error as its own step failure, as before. */
function readOrEmpty(deps: SetupDeps): string {
  try {
    return deps.readConfigText()
  } catch {
    return ''
  }
}
