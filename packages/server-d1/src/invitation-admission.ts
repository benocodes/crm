// The invitation gate and acceptance, composed ([[CORE287]], [[CORE259]] D5): the port `@vibase/auth` is handed so it never reaches the CRM or the control database itself. The gate reads the control
// plane; settling runs the vault's acceptance program (the commit point) and then marks the invitation accepted with its audit row, in that order.
import { acceptInvitedAccount, hashInvitationToken, linkedPrincipalId } from '@vibase/api'
import type { InvitationAdmission } from '@vibase/auth'
import type { D1Binding } from '@vibase/storage'
import type { InvitationRecord } from '@vibase/storage-d1'

/** The control-plane reads and writes the gate needs, as the Worker composition binds them to the control store: this module never holds the control handle ([[CORE259]] D5, `control-boundary.test.ts`). */
export interface InvitationAdmissionStore {
  hasLive(a: { tokenHash: string; email: string; now: string }): Promise<boolean>
  findAdoptable(a: { email: string; accountCreatedAt: string; now: string }): Promise<InvitationRecord | null>
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
    async settle({ subject, email, name, emailVerified, accountCreatedAt }) {
      const storage = await d.crm()
      const linked = await linkedPrincipalId(storage, subject)
      const now = d.clock()
      const address = email.trim().toLowerCase()
      // P5: only the invitation that admitted this account (live, created no later than the account) adopts it; anything else leaves the subject inert.
      const invitation = await d.store.findAdoptable({ email: address, accountCreatedAt: accountCreatedAt.toISOString(), now: now.toISOString() })
      if (!invitation) return
      // Amended P5: a linked subject never re-runs the CRM program, but if the control batch of an earlier acceptance failed, its admitting invitation is still live: complete P4 only, actor the linked principal.
      if (linked) {
        await d.store.accept({ id: invitation.id, auditId: d.newId(), actorId: linked, now: now.toISOString() })
        return
      }
      // P3: the CRM program is the commit point; if it throws, nothing below runs and the invitation stays pending.
      const { principalId } = await acceptInvitedAccount(storage, { now, newId: d.newId }, { role: invitation.role, subject, email: address, name, emailVerified })
      // P4: marked accepted only after the commit, guarded on the invitation still being live. A revoke that landed in between leaves the membership ([[CORE288]] removes it).
      await d.store.accept({ id: invitation.id, auditId: d.newId(), actorId: principalId, now: now.toISOString() })
    },
  }
}
