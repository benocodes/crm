// [[OPS307]] D9, D10, D11: the owner recovery both front-ends share (`vibase-server owner-reset` and `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env <name> --owner-reset`).
// One targeting rule, one link, one invitation; a front-end supplies the instance's record, the secrets file's `AUTH_SECRET` and the way to open the remote databases, and maps the outcome to its exit code.
//
//  - Targets are the live `owner` memberships whose users are `better-auth` users. `--email` must name one; without it there must be exactly one.
//  - With NO owner membership of any provider it issues an owner invitation instead (D11, P2). Owners that exist but none on `better-auth` are refused: an invitation beside a working owner on another
//    provider would hand out a second owner seat.
//  - The reset link is Better Auth's own, issued in this process against the remote control database (D10): `issueResetToken`, then the `user.reset_link_issued` audit row, and only then is the link returned.
//    If the audit write fails nothing is returned and the unused verification row expires (P3 a). It never writes the CRM database.
// Nothing here prints: it returns the outcome; `AUTH_SECRET` is only ever handed to `createAuth`, and no error message holds a token or a URL.
import { INVITATION_TTL_MS, invitationUrl, newInvitationToken, normaliseInvitationEmail } from '@vibase/api'
import { uuidv7 } from '@vibase/storage'
import { openControlDb, reissueOwnerInvitation, type D1Like } from '@vibase/storage-d1'
import { AUTH_SECRET_MIN_LENGTH } from '../src/auth-config.js'
import { ResetAuditError, issueResetLink } from './reset-link.js'

/** Refused before any write: nothing was changed. */
export class OwnerResetRefusal extends Error {}
/** Failed after a write began: something may have been changed (the message says what). */
export class OwnerResetFailure extends Error {}

/** What the instance's record says (the settings file, or the env block of `wrangler.jsonc`). */
export interface OwnerResetRecord {
  /** `better-auth`, `clerk` or `none` (an absent `AUTH_PROVIDER` is `none`). */
  authProvider: string
  /** The record binds a control database. */
  hasControl: boolean
  publicBaseUrl: string | undefined
}
export interface OwnerResetDatabases {
  crm: D1Like
  control: D1Like | undefined
}
export interface OwnerResetParams {
  record: OwnerResetRecord
  /** `AUTH_SECRET` as the instance's secrets file holds it. Absent: refused on the reset path (OPS249 D3 state d). */
  authSecret: string | undefined
  /** The secrets file as shown to the operator (a path, or `.env.<env>`). */
  secretsFile: string
  email: string | undefined
  dryRun: boolean
  /** Opens the instance's remote databases for `fn` and closes them after. Called only once every check on the record has passed. */
  withDatabases<T>(fn: (dbs: OwnerResetDatabases) => Promise<T>): Promise<T>
  now?: () => Date
  newId?: () => string
  randomBytes?: (n: number) => Uint8Array
}
export type OwnerResetResult =
  | { kind: 'dry-run'; action: 'reset' | 'invitation'; email: string }
  | { kind: 'reset'; email: string; url: string; expiresAt: string }
  | { kind: 'invitation'; email: string; url: string; expiresAt: string; revoked: number }

const message = (e: unknown) => (e instanceof Error ? e.message : 'unknown error')

/** The record checks, in order, before anything is opened. */
function checkRecord(r: OwnerResetRecord): string {
  if (r.authProvider === 'clerk')
    throw new OwnerResetRefusal(
      'this instance signs in through Clerk: recover the owner through Clerk (owner-reset is for better-auth instances)',
    )
  if (r.authProvider !== 'better-auth')
    throw new OwnerResetRefusal(
      `this instance's provider is ${r.authProvider === 'none' ? 'none (API keys only)' : r.authProvider}: it has no Better Auth accounts to recover (owner-reset is for better-auth instances)`,
    )
  if (!r.hasControl)
    throw new OwnerResetRefusal(
      'the instance record binds no control database (CONTROL_DB): a better-auth instance keeps its accounts there',
    )
  if (!r.publicBaseUrl)
    throw new OwnerResetRefusal(
      'the instance record has no PUBLIC_BASE_URL: it is the origin of the link and of the Better Auth issuer',
    )
  return r.publicBaseUrl.replace(/\/+$/, '')
}

export async function ownerReset(p: OwnerResetParams): Promise<OwnerResetResult> {
  const baseUrl = checkRecord(p.record)
  const wanted = p.email === undefined ? undefined : normaliseInvitationEmail(p.email)
  if (p.email !== undefined && wanted === null) throw new OwnerResetRefusal(`--email ${p.email} is not a valid address`)
  let wrote = false
  try {
    return await p.withDatabases(async ({ crm, control }) => {
      if (!control) throw new OwnerResetRefusal('the control database is not bound in the instance proxy')
      const now = p.now?.() ?? new Date()
      const newId = p.newId ?? (() => uuidv7())
      const one = async (sql: string) => (await crm.prepare(sql).first()) as Record<string, unknown> | null
      const owners = (
        (
          await crm
            .prepare(
              "select u.email, u.auth_provider, u.auth_subject from memberships m join users u on u.id = m.user_id where m.role = 'owner' and m.deleted_at is null order by u.email",
            )
            .all()
        ).results ?? []
      ).map((r) => r as { email: string; auth_provider: string | null; auth_subject: string | null })
      const system = (await one("select id from principals where kind = 'system' limit 1"))?.id as string | undefined
      if (!system)
        throw new OwnerResetRefusal('the CRM database has no system principal: the organisation is not initialised')

      // No owner of any provider: an owner invitation (D11, P2).
      if (owners.length === 0) {
        if (wanted === undefined)
          throw new OwnerResetRefusal(
            '--email <address> is required: this instance has no owner, so owner-reset issues an owner invitation for that address',
          )
        const org = (await one('select id from organizations limit 1'))?.id as string | undefined
        if (!org) throw new OwnerResetRefusal('the CRM database has no organisation: initialise it first (bootstrap)')
        if (p.dryRun) return { kind: 'dry-run', action: 'invitation', email: wanted! }
        const { token, hash } = await newInvitationToken(
          p.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n))),
        )
        const id = newId()
        const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS).toISOString()
        wrote = true
        const out = await reissueOwnerInvitation(openControlDb(control), {
          id,
          auditId: newId(),
          newAuditId: newId,
          organizationId: org,
          email: wanted!,
          role: 'owner',
          tokenHash: hash,
          expiresAt,
          createdBy: system,
          now: now.toISOString(),
        })
        if (out.result === 'live_exists') {
          wrote = false
          throw new OwnerResetRefusal(
            `a live invitation for ${wanted} already exists with another role: revoke it (invitations.revoke) and run again; nothing was changed`,
          )
        }
        return {
          kind: 'invitation',
          email: wanted!,
          url: invitationUrl(baseUrl, token),
          expiresAt,
          revoked: out.revoked,
        }
      }

      // Owners exist: only a better-auth owner can be reset.
      const targets = owners.filter((o) => o.auth_provider === 'better-auth')
      if (targets.length === 0) {
        const providers = [...new Set(owners.map((o) => o.auth_provider ?? 'none'))].join(', ')
        throw new OwnerResetRefusal(
          `this instance's owners sign in through ${providers}, not better-auth: recover through ${providers}; owner-reset issues no invitation beside a working owner`,
        )
      }
      let target = targets[0]!
      if (wanted !== undefined) {
        const hit = targets.find((o) => o.email === wanted)
        if (!hit)
          throw new OwnerResetRefusal(
            `--email ${wanted} is not an owner of this instance on better-auth (owners: ${targets.map((o) => o.email).join(', ')})`,
          )
        target = hit
      } else if (targets.length > 1) {
        throw new OwnerResetRefusal(
          `this instance has ${targets.length} better-auth owners: pass --email <address> with one of ${targets.map((o) => o.email).join(', ')}`,
        )
      }
      if (!p.authSecret)
        throw new OwnerResetRefusal(
          `AUTH_SECRET is not in ${p.secretsFile}: owner-reset needs it to compose Better Auth as the Worker does. If the Worker has one, copy it into that file; a new value would sign everyone out`,
        )
      if (p.authSecret.length < AUTH_SECRET_MIN_LENGTH)
        throw new OwnerResetRefusal(
          `AUTH_SECRET in ${p.secretsFile} is shorter than ${AUTH_SECRET_MIN_LENGTH} characters: it is not the value the Worker holds`,
        )
      // `users` holds `auth_provider` and `auth_subject` both or neither (a CHECK), so a better-auth owner always has a subject.
      const subject = target.auth_subject as string
      if (p.dryRun) return { kind: 'dry-run', action: 'reset', email: target.email }

      wrote = true
      let link: Awaited<ReturnType<typeof issueResetLink>>
      try {
        link = await issueResetLink({
          control,
          baseUrl,
          authSecret: p.authSecret,
          email: target.email,
          subject,
          actorId: system,
          via: 'owner-reset',
          now,
          newAuditId: newId,
        })
      } catch (e) {
        if (e instanceof ResetAuditError)
          throw new OwnerResetFailure(
            `the reset link was not recorded in the audit log (${e.message}): nothing was printed; the unused link expires, run again`,
          )
        throw new OwnerResetFailure(
          `the reset link could not be issued (${message(e)}): nothing was printed; run again`,
        )
      }
      if (!link) {
        wrote = false
        throw new OwnerResetRefusal(`no Better Auth account exists for ${target.email}: nothing was written`)
      }
      return { kind: 'reset', email: target.email, url: link.url, expiresAt: link.expiresAt }
    })
  } catch (e) {
    if (e instanceof OwnerResetRefusal || e instanceof OwnerResetFailure) throw e
    if (wrote) throw new OwnerResetFailure(`failed after a write began (${message(e)}): nothing was printed; run again`)
    throw new OwnerResetRefusal(`could not read the instance (${message(e)}): nothing was written`)
  }
}

/** The lines a front-end prints for a result. The link or invitation URL appears in exactly one line, once. */
export function ownerResetLines(r: OwnerResetResult): string[] {
  if (r.kind === 'dry-run') {
    return [
      r.action === 'reset'
        ? `dry run: would issue an owner reset link for ${r.email}`
        : `dry run: this instance has no owner: would issue an owner invitation for ${r.email}`,
      'dry run: nothing was written',
    ]
  }
  if (r.kind === 'reset')
    return [`owner reset link for ${r.email} (expires ${r.expiresAt}; shown once, stored nowhere): ${r.url}`]
  return [
    `owner invitation for ${r.email} (expires ${r.expiresAt}; shown once, stored nowhere${r.revoked > 0 ? `; it replaced ${r.revoked} live owner invitation${r.revoked === 1 ? '' : 's'}` : ''}): ${r.url}`,
  ]
}
