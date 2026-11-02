// `setup:remote` ([[OPS65]] D6): parse and guard first (no subprocess, no network), then the steps in D11 order.
import { RemoteRefusal, requireConfirm } from '../remote.js'
import { parseSetupArgs } from './args.js'
import { STEPS, type Ctx } from './steps.js'
import { STEP_NAMES, type SetupDeps, type StepResult } from './types.js'

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
    const opts = parseSetupArgs(argv)
    if (!opts.dryRun) requireConfirm(procEnv)
    ctx = { opts, deps, creds: deps.loadEnv(), pending: false }
  } catch (err) {
    if (!(err instanceof RemoteRefusal)) throw err
    deps.log(`setup: ${err.message}`)
    return { exitCode: 1, results: [], stoppedAfterConfigWrite: false }
  }
  const { opts } = ctx
  const selected = STEP_NAMES.filter((s) => opts.only === undefined || opts.only.includes(s))
  deps.log(`setup:remote env ${opts.env}, auth ${opts.auth}, api host ${opts.apiHost}${opts.dryRun ? ' (dry run: reads only)' : ''}`)
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
  const manual = results.filter((r) => r.status === 'manual')
  if (manual.length > 0) {
    deps.log('manual:')
    for (const r of manual) deps.log(`  ${r.step}: ${r.detail}`)
  }
  const failed = results.some((r) => r.status === 'fail')
  deps.log(failed ? 'setup: failed' : ctx.stop ? 'setup: stopped after writing wrangler.jsonc; commit it and re-run' : opts.dryRun ? 'setup: dry run complete, nothing was changed' : 'setup: done')
  return { exitCode: failed ? 1 : 0, results, stoppedAfterConfigWrite: ctx.stop === true }
}
