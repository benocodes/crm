// The repair sweep's pending counts for the two status commands ([[CORE289]] P6): the control and CRM reads through wrangler's `d1 execute --json`, parsed and classified by the sweep's own
// `classifySweep` ([[CORE259]] D10). Read-only: both statements are SELECTs. A count that cannot be read is `null` and prints `unavailable`; it never changes an exit code.
import { SWEEP_CONTROL_READ, SWEEP_CRM_READ, classifySweep, parseSweepControlRows, parseSweepCrmRows } from '@vibase/storage-d1'

export interface SweepCounts {
  revoke: number
  orphans: number
}

/** The rows of wrangler's `--json` output: `[ { results: [...], success } ]`; an `error` object or any other shape throws. */
function rowsOf(stdout: string): unknown[] {
  const json: unknown = JSON.parse(stdout)
  const error = (json as { error?: { text?: unknown } } | null)?.error
  if (error) throw new Error(`wrangler d1 execute failed: ${typeof error.text === 'string' ? error.text : 'unknown error'}`)
  const results = Array.isArray(json) ? (json[0] as { results?: unknown } | undefined)?.results : undefined
  if (!Array.isArray(results)) throw new Error('unexpected output shape from wrangler d1 execute')
  return results
}

/** `run(binding, sql)` returns wrangler's `--json` stdout and throws on a failed run. `null`: a read failed or its output was not what the statement returns. */
export function readSweepCounts(run: (binding: 'DB' | 'CONTROL_DB', sql: string) => string, now: Date): SweepCounts | null {
  try {
    const control = parseSweepControlRows(rowsOf(run('CONTROL_DB', SWEEP_CONTROL_READ)))
    const crm = parseSweepCrmRows(rowsOf(run('DB', SWEEP_CRM_READ)))
    const plan = classifySweep({ now: now.toISOString(), control, crm })
    return { revoke: plan.revoke.length, orphans: plan.orphans.length }
  } catch {
    return null
  }
}

/** The lines a status command prints, without the `[control] ` prefix. */
export function sweepCountLines(counts: SweepCounts | null): string[] {
  if (!counts) return ['sweep: counts unavailable']
  return [`sweep: ${counts.revoke} subject(s) pending revocation`, `sweep: ${counts.orphans} orphan account(s) pending deletion`]
}
