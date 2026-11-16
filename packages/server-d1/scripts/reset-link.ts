// The one path that issues a Better Auth password-reset link in-process against a remote control database ([[CORE243]] D15, [[OPS307]] D10), shared by `owner-reset` and `auth:migrate:remote -- claim` ([[OPS397]] P2):
// `issueResetToken`, then the `user.reset_link_issued` audit row, and only then the URL is returned. If the audit write fails nothing is returned and the unused verification row expires.
// Nothing here prints; `authSecret` is only ever handed to `createAuth`, and no error message holds a token or a URL.
import { passwordResetUrl } from '@vibase/api'
import { createAuth } from '@vibase/auth'
import { controlAuthDatabase, openControlDb, recordResetLinkIssued, type D1Like } from '@vibase/storage-d1'

/** The token could not be issued (nothing was recorded). */
export class ResetTokenError extends Error {}
/** The token was issued but its audit row was not written: nothing is returned, the unused link expires. */
export class ResetAuditError extends Error {}

const message = (e: unknown) => (e instanceof Error ? e.message : 'unknown error')

export interface ResetLinkParams {
  control: D1Like
  /** The origin of the link and of the Better Auth issuer, without a trailing slash. */
  baseUrl: string
  authSecret: string
  /** The account's address: Better Auth finds the user by it. */
  email: string
  /** The `auth_users` id, recorded as the audit row's target. */
  subject: string
  /** The system principal that acts for the command. */
  actorId: string
  /** Which command issued it, recorded in the audit row's detail. */
  via: string
  now: Date
  newAuditId: () => string
}
/** `null`: no Better Auth account exists for the address (nothing was written). */
export async function issueResetLink(p: ResetLinkParams): Promise<{ url: string; expiresAt: string } | null> {
  const auth = createAuth(controlAuthDatabase(openControlDb(p.control)), { secret: p.authSecret, baseURL: p.baseUrl })
  let issued: { token: string; expiresAt: Date } | null
  try {
    issued = await auth.issueResetToken(p.email)
  } catch (e) {
    throw new ResetTokenError(message(e))
  }
  if (!issued) return null
  const expiresAt = issued.expiresAt.toISOString()
  try {
    await recordResetLinkIssued(openControlDb(p.control), {
      auditId: p.newAuditId(),
      actorId: p.actorId,
      subject: p.subject,
      expiresAt,
      now: p.now.toISOString(),
      via: p.via,
    })
  } catch (e) {
    throw new ResetAuditError(message(e))
  }
  return { url: passwordResetUrl(p.baseUrl, issued.token), expiresAt }
}
