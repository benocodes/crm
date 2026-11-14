// The invitation gate and acceptance, composed ([[CORE287]], [[CORE259]] D5): the port `@vibase/auth` is handed so it never reaches the CRM or the control database itself. The gate reads the control
// plane; settling runs the vault's acceptance program (the commit point) and then marks the invitation accepted with its audit row, in that order.
import { acceptInvitedAccount, hashInvitationToken, isSubjectLinked } from '@vibase/api'
import type { InvitationAdmission } from '@vibase/auth'
import type { D1Binding } from '@vibase/storage'
import { acceptInvitation, findAdoptableInvitation, hasLiveInvitationForToken, type ControlDb } from '@vibase/storage-d1'

export interface InvitationAdmissionDeps {
  control: ControlDb
  /** The CRM binding, resolved per call (the Worker's deployment row), never cached across the gates. */
  crm(): Promise<D1Binding>
  clock(): Date
  newId(): string
}

export function invitationAdmission(d: InvitationAdmissionDeps): InvitationAdmission {
  return {
    async admits({ email, token }) {
      return hasLiveInvitationForToken(d.control, { tokenHash: await hashInvitationToken(token), email: email.trim().toLowerCase(), now: d.clock().toISOString() })
    },
    async settle({ subject, email, name, accountCreatedAt }) {
      const storage = await d.crm()
      // P5: a linked subject (a users row or an agent account) never re-runs acceptance.
      if (await isSubjectLinked(storage, subject)) return
      const now = d.clock()
      const address = email.trim().toLowerCase()
      // P5: only the invitation that admitted this account (live, created no later than the account) adopts it; anything else leaves the subject inert.
      const invitation = await findAdoptableInvitation(d.control, { email: address, accountCreatedAt: accountCreatedAt.toISOString(), now: now.toISOString() })
      if (!invitation) return
      // P3: the CRM program is the commit point; if it throws, nothing below runs and the invitation stays pending.
      const { principalId } = await acceptInvitedAccount(storage, { now, newId: d.newId }, { role: invitation.role, subject, email: address, name })
      // P4: marked accepted only after the commit, guarded on the invitation still being live. A revoke that landed in between leaves the membership ([[CORE288]] removes it).
      await acceptInvitation(d.control, { id: invitation.id, auditId: d.newId(), actorId: principalId, now: now.toISOString() })
    },
  }
}
