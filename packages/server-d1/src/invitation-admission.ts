// The invitation gate and acceptance, composed ([[CORE287]], [[CORE259]] D5): the port `@vibase/auth` is handed so it never reaches the CRM or the control database itself. The gate reads the control
// plane; settling runs the vault's acceptance program (the commit point) and then marks the invitation accepted with its audit row, in that order.
import { acceptInvitedAccount, hashInvitationToken, readmitMember, subjectStanding } from '@vibase/api'
import type { InvitationAdmission } from '@vibase/auth'
import type { D1Binding } from '@vibase/storage'
import type { InvitationRecord } from '@vibase/storage-d1'

/** The control-plane reads and writes the gate needs, as the Worker composition binds them to the control store: this module never holds the control handle ([[CORE259]] D5, `control-boundary.test.ts`). */
export interface InvitationAdmissionStore {
  hasLive(a: { tokenHash: string; email: string; now: string }): Promise<boolean>
  findAdoptable(a: { email: string; accountCreatedAt: string; now: string }): Promise<InvitationRecord | null>
  findLiveByToken(a: { tokenHash: string; email: string; now: string }): Promise<InvitationRecord | null>
  accept(a: { id: string; auditId: string; actorId: string; now: string }): Promise<'accepted' | 'not_live'>
}

export interface InvitationAdmissionDeps {
  store: InvitationAdmissionStore
  /** The CRM binding, resolved per call (the Worker's deployment row), never cached across the gates. */
  crm(): Promise<D1Binding>
  clock(): Date
  newId(): string
}

export function invitationAdmission(d: InvitationAdmissionDeps): InvitationAdmission {
  return {
    async admits({ email, token }) {
      return d.store.hasLive({ tokenHash: await hashInvitationToken(token), email: email.trim().toLowerCase(), now: d.clock().toISOString() })
    },
    async settle({ subject, email, name, emailVerified, accountCreatedAt, token }) {
      const storage = await d.crm()
      const standing = await subjectStanding(storage, subject)
      const now = d.clock()
      const address = email.trim().toLowerCase()
      if (standing?.kind === 'user') {
        // Amended P5 ([[CORE302]] P4): a human with a LIVE membership never re-runs the CRM program. If a live invitation for its email created no later than that membership still exists (only the admitting one
        // can), an earlier acceptance's control batch failed: complete it, actor the user's principal. A token changes nothing here (no role change by invitation).
        if (standing.liveMembershipCreatedAt !== null) {
          const pending = await d.store.findAdoptable({ email: address, accountCreatedAt: standing.liveMembershipCreatedAt, now: now.toISOString() })
          if (pending) await d.store.accept({ id: pending.id, auditId: d.newId(), actorId: standing.id, now: now.toISOString() })
          return
        }
        // P1: a removed member (a `users` row, no live membership) is re-admitted by a live invitation token for its email, for a human role; anything else is ignored (P3), the sign-in kept.
        if (token === undefined || token === '') return
        const invitation = await d.store.findLiveByToken({ tokenHash: await hashInvitationToken(token), email: address, now: now.toISOString() })
        if (!invitation || invitation.role === 'agent') return
        // P2: the CRM unit is the commit point (a new membership, the removed row stays); then the guarded control batch. A [[CORE248]] D5 emailed invitation proves the mailbox: `email_verified` true.
        await readmitMember(storage, { now, newId: d.newId }, { subject, role: invitation.role, verifyEmail: invitation.delivery === 'email' })
        await d.store.accept({ id: invitation.id, auditId: d.newId(), actorId: standing.id, now: now.toISOString() })
        return
      }
      // P5: only the invitation that admitted this account (live, created no later than the account) adopts it; anything else leaves the subject inert. A token never adopts an orphan ([[CORE287]] P7).
      const invitation = await d.store.findAdoptable({ email: address, accountCreatedAt: accountCreatedAt.toISOString(), now: now.toISOString() })
      if (!invitation) return
      // Amended P5: an agent account never re-runs the CRM program, but if the control batch of its acceptance failed, its admitting invitation is still live: complete P4 only, actor the agent.
      if (standing) {
        await d.store.accept({ id: invitation.id, auditId: d.newId(), actorId: standing.id, now: now.toISOString() })
        return
      }
      // [[CORE248]] D5: an emailed invitation's token never left the vault but toward the address, so accepting it proves the mailbox; a link proves nothing (Google's own verified flag still counts).
      // P3: the CRM program is the commit point; if it throws, nothing below runs and the invitation stays pending.
      const { principalId } = await acceptInvitedAccount(storage, { now, newId: d.newId }, { role: invitation.role, subject, email: address, name, emailVerified: emailVerified || invitation.delivery === 'email' })
      // P4: marked accepted only after the commit, guarded on the invitation still being live. A revoke that landed in between leaves the membership ([[CORE288]] removes it).
      await d.store.accept({ id: invitation.id, auditId: d.newId(), actorId: principalId, now: now.toISOString() })
    },
  }
}
