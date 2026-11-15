// The repair sweep's facts and classifier ([[CORE259]] D10, [[CORE289]]): pure. The same read statements, row parsers and `classifySweep` serve the one-minute cron (through the control store)
// and the two status commands (through wrangler's `d1 execute --json`), so "what the next sweep would do" is one function. The read statements they share are SELECTs.
// This module names no table and holds no database handle; the control store holds the statements (the auth tables are named only there) and reads and writes with them.

/** An account is an orphan candidate only when strictly older than this ([[CORE289]] P2). */
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000

export interface SweepControlFacts {
  users: Array<{ id: string; email: string; createdAt: string }>
  credentialSubjects: string[]
  invitations: Array<{ email: string; createdAt: string; acceptedAt: string | null; revokedAt: string | null; expiresAt: string }>
}
export interface SweepCrmFacts {
  linked: Array<{ subject: string; authority: boolean }>
}
export interface SweepPlan {
  /** Linked subjects without authority that still hold credentials. */
  revoke: string[]
  /** Unlinked accounts over 24 hours with no keeping invitation. */
  orphans: string[]
}

const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new Error(`unexpected ${what} in the sweep read`)
  return v
}
const textOrNull = (v: unknown, what: string): string | null => (v === null || v === undefined ? null : text(v, what))

/** The rows of `SWEEP_CONTROL_READ`, as the database or wrangler's `--json` gave them. A shape that is not the statement's throws: a caller turns that into "unavailable". */
export function parseSweepControlRows(rows: unknown): SweepControlFacts {
  if (!Array.isArray(rows)) throw new Error('unexpected sweep read shape')
  const facts: SweepControlFacts = { users: [], credentialSubjects: [], invitations: [] }
  for (const r of rows as Array<Record<string, unknown>>) {
    if (r?.kind === 'user') facts.users.push({ id: text(r.k1, 'user id'), email: text(r.k2, 'user email'), createdAt: text(r.k3, 'user created_at') })
    else if (r?.kind === 'credential') facts.credentialSubjects.push(text(r.k1, 'credential subject'))
    else if (r?.kind === 'invitation') facts.invitations.push({ email: text(r.k1, 'invitation email'), createdAt: text(r.k2, 'invitation created_at'), acceptedAt: textOrNull(r.k3, 'accepted_at'), revokedAt: textOrNull(r.k4, 'revoked_at'), expiresAt: text(r.k5, 'expires_at') })
    else throw new Error('unexpected row kind in the sweep read')
  }
  return facts
}

/** The rows of `SWEEP_CRM_READ`. */
export function parseSweepCrmRows(rows: unknown): SweepCrmFacts {
  if (!Array.isArray(rows)) throw new Error('unexpected sweep read shape')
  const authority = new Map<string, boolean>()
  for (const r of rows as Array<Record<string, unknown>>) {
    const subject = text(r?.subject, 'subject')
    authority.set(subject, (authority.get(subject) ?? false) || Number(r.authority) === 1)
  }
  return { linked: [...authority].map(([subject, a]) => ({ subject, authority: a })) }
}

/** The instant an account must be strictly older than, as ISO text (the one encoding Better Auth and the invitations both store). */
export function orphanCutoff(now: string): string {
  return new Date(Date.parse(now) - ORPHAN_AGE_MS).toISOString()
}

/**
 * What the next sweep does ([[CORE289]] P1, P2). `revoke`: linked subjects with no authority that still hold a credential. `orphans`: accounts no CRM row names, strictly older than 24 hours,
 * that no invitation created no later than the account, live or accepted, keeps.
 */
export function classifySweep(a: { now: string; control: SweepControlFacts; crm: SweepCrmFacts }): SweepPlan {
  const linked = new Map(a.crm.linked.map((l) => [l.subject, l.authority]))
  const revoke = [...new Set(a.control.credentialSubjects)].filter((s) => linked.get(s) === false)
  const cutoff = orphanCutoff(a.now)
  const orphans = a.control.users
    .filter((u) => !linked.has(u.id) && u.createdAt < cutoff)
    .filter((u) => !a.control.invitations.some((i) => i.email === u.email.toLowerCase() && i.createdAt <= u.createdAt && (i.acceptedAt !== null || (i.revokedAt === null && i.expiresAt > a.now))))
    .map((u) => u.id)
  return { revoke, orphans }
}
