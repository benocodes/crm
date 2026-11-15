// Shared fixture builder for the status commands' sweep counts ([[CORE289]] P6, OPS306 lesson): one place that turns sweep facts into wrangler `d1 execute --json` stdout, so both front-ends
// build the same rows. `fixtures/d1-execute-sweep-*.json` are captured from a real `wrangler d1 execute --local --json` run; a test pins this builder to them.
import { SWEEP_CONTROL_READ, SWEEP_CRM_READ, type SweepControlFacts, type SweepCrmFacts } from '@vibase/storage-d1'

export const wranglerJson = (rows: Array<Record<string, unknown>>): string =>
  JSON.stringify([{ results: rows, success: true, meta: { duration: 0 } }], null, 2)

export function controlStdout(f: SweepControlFacts): string {
  return wranglerJson([
    ...f.users.map((u) => ({ kind: 'user', k1: u.id, k2: u.email, k3: u.createdAt, k4: null, k5: null })),
    ...f.credentialSubjects.map((s) => ({ kind: 'credential', k1: s, k2: null, k3: null, k4: null, k5: null })),
    ...f.invitations.map((i) => ({
      kind: 'invitation',
      k1: i.email,
      k2: i.createdAt,
      k3: i.acceptedAt,
      k4: i.revokedAt,
      k5: i.expiresAt,
    })),
  ])
}
export const crmStdout = (f: SweepCrmFacts): string =>
  wranglerJson(f.linked.map((l) => ({ subject: l.subject, authority: l.authority ? 1 : 0 })))

/** Which sweep read a command line carries: its `--command` argument is the shared statement. */
export const sweepReadOf = (args: readonly string[]): 'control' | 'crm' | null => {
  const sql = args[args.indexOf('--command') + 1]
  return sql === SWEEP_CONTROL_READ ? 'control' : sql === SWEEP_CRM_READ ? 'crm' : null
}

/** A read-only statement: one SELECT, no write or DDL keyword. */
export const isReadOnlySql = (sql: string): boolean =>
  /^\s*select\b/i.test(sql) && !/\b(insert|update|delete|drop|alter|create|replace|pragma|attach)\b/i.test(sql)

/** One fixture for both front-ends: relative to the real clock the commands use. Expected counts: one subject pending revocation (`gone`), one orphan pending deletion (`orphan`). */
export function countsFacts(now = Date.now()): {
  control: SweepControlFacts
  crm: SweepCrmFacts
  expected: { revoke: number; orphans: number }
} {
  const ago = (ms: number) => new Date(now - ms).toISOString()
  return {
    control: {
      users: [
        { id: 'gone', email: 'gone@x.test', createdAt: ago(30 * 86_400_000) },
        { id: 'live', email: 'live@x.test', createdAt: ago(30 * 86_400_000) },
        { id: 'orphan', email: 'orphan@x.test', createdAt: ago(3 * 86_400_000) },
        { id: 'young', email: 'young@x.test', createdAt: ago(3_600_000) },
      ],
      credentialSubjects: ['gone', 'live'],
      invitations: [],
    },
    crm: {
      linked: [
        { subject: 'gone', authority: false },
        { subject: 'live', authority: true },
      ],
    },
    expected: { revoke: 1, orphans: 1 },
  }
}
