// The repair sweep's pending counts for the two status commands ([[CORE289]] P6): the control and CRM reads through wrangler's `d1 execute --json`, parsed and classified by the sweep's own
// `classifySweep` ([[CORE259]] D10). Read-only: both statements are SELECTs. A count that cannot be read is `null` and prints `unavailable`; it never changes an exit code.

export interface SweepCounts {
  revoke: number
  orphans: number
}

/** `run(binding, sql)` returns wrangler's `--json` stdout and throws on a failed run. */
export function readSweepCounts(_run: (binding: 'DB' | 'CONTROL_DB', sql: string) => string, _now: Date): SweepCounts | null {
  throw new Error('not implemented')
}

/** The lines a status command prints, without the `[control] ` prefix. */
export function sweepCountLines(_counts: SweepCounts | null): string[] {
  throw new Error('not implemented')
}
