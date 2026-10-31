import type { D1Like } from './binding.js'

export type MigrationStatus = 'current' | 'behind' | 'ahead' | 'unknown'

export interface MigrationDiff {
  status: Exclude<MigrationStatus, 'unknown'>
  missing: string[]
  extra: string[]
}

export interface MigrationState {
  status: MigrationStatus
  /** The names found in `d1_migrations`; empty when `unknown`. */
  applied: string[]
  /** True when the read threw for a reason other than the tracker being absent: the caller must not remember it. */
  readFailed: boolean
}

/** The D9 rule: a set difference by name. `behind` wins whenever anything expected is missing; order and `applied_at` are ignored. */
export function compareMigrations(applied: readonly string[], expected: readonly string[]): MigrationDiff {
  const have = new Set(applied)
  const want = new Set(expected)
  const missing = expected.filter((n) => !have.has(n))
  const extra = [...have].filter((n) => !want.has(n))
  return { status: missing.length > 0 ? 'behind' : extra.length > 0 ? 'ahead' : 'current', missing, extra }
}

const MISSING_TABLE = /no such table/i

/**
 * Reads wrangler's tracker. A missing table is `unknown` (a database not created through wrangler); any other thrown read is
 * `unknown` too, flagged `readFailed` so a caller does not remember it ([[CORE61]] D6).
 */
export async function readMigrationState(d1: D1Like, expected: readonly string[]): Promise<MigrationState> {
  try {
    const { results } = await d1.prepare('select name from d1_migrations').all()
    const applied = (results ?? []).map((r) => (r as { name: string }).name)
    return { status: compareMigrations(applied, expected).status, applied, readFailed: false }
  } catch (err) {
    const message = `${(err as Error | null)?.message ?? ''} ${((err as Error | null)?.cause as Error | undefined)?.message ?? ''}`
    return { status: 'unknown', applied: [], readFailed: !MISSING_TABLE.test(message) }
  }
}
