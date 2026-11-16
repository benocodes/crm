// The claim side of the hq auth migration ([[OPS397]], [[OPS250]] D4, D6, D15): after apply, one password-reset link per migrated person and per relinked agent account, and the caps of every delegated agent apply disabled.
// A claim link is Better Auth's own reset link on the `auth_users` row apply created (no credential account yet), issued in-process through `owner-reset`'s path (`issueResetLink`): token, audit row, and only then the URL, printed once.
// Nothing is written to the CRM, to a file or to an argument list. Targets are issued one at a time; a failure after one began exits 2 and names who got a link.
import { normaliseInvitationEmail } from '@vibase/api'
import type { D1Like } from '@vibase/storage-d1'
import { ApplyFailure } from './apply.js'
import { ResetAuditError, issueResetLink } from '../reset-link.js'
import type { AuthPlan } from './types.js'

/** Refused before any write: nothing was changed (exit 1). */
export class ClaimRefusal extends Error {}
/** Failed after an issue began (exit 2): the message names who got a link and who did not. */
export class ClaimFailure extends ApplyFailure {}

export const CLAIM_VIA = 'auth-migrate-claim'

export interface ClaimParams {
  plan: AuthPlan
  crm: D1Like
  control: D1Like
  authSecret: string
  /** The origin of the links, without a trailing slash. */
  baseUrl: string
  email: string | undefined
  dryRun: boolean
  now(): Date
  newId(): string
  /** One stdout line. A link goes through here exactly once, after its audit row committed. */
  log(line: string): void
}

interface Target {
  kind: 'person' | 'agent account'
  email: string
  subject: string
  claimed: boolean
}

const message = (e: unknown) => (e instanceof Error ? e.message : 'unknown error')
const label = (t: Pick<Target, 'kind'>) => t.kind

/** Plan people `migrate` then agent accounts `relink`, in the plan's order, with the address each `auth_users` row holds and whether it already has any account row (a password or Google). */
async function targetsOf(plan: AuthPlan, control: D1Like): Promise<Target[]> {
  const wanted = [
    ...plan.people
      .filter((p) => p.action === 'migrate')
      .map((p) => ({ kind: 'person' as const, subject: p.new_auth_user_id! })),
    ...plan.agents
      .filter((a) => a.action === 'relink')
      .map((a) => ({ kind: 'agent account' as const, subject: a.new_auth_user_id! })),
  ]
  const out: Target[] = []
  for (const w of wanted) {
    const user = (await control.prepare('select email from auth_users where id = ?').bind(w.subject).first()) as {
      email: string
    } | null
    if (!user)
      throw new ClaimRefusal(
        `auth user ${w.subject} is missing from the control database although the instance reads as applied: plan again, or look at the control rows`,
      )
    const account = await control
      .prepare('select 1 as n from auth_accounts where user_id = ? limit 1')
      .bind(w.subject)
      .first()
    out.push({ ...w, email: user.email, claimed: account !== null })
  }
  return out
}

/** P4: the delegated agents apply disabled, from the plan alone (an already-disabled one is `keep`, an agent account is not delegated). */
function capsLines(plan: AuthPlan): string[] {
  return plan.agents
    .filter((a) => a.kind === 'delegated' && a.action === 'disable')
    .map(
      (a) =>
        `caps: delegated agent ${a.id} "${a.name}" was disabled by apply; its scopes were ${(a.scopes ?? []).join(', ') || '(none)'}: reconnect the client and grant these scopes to the new delegated agent`,
    )
}

/** Every refusal is raised before the first line is printed or the first write. */
export async function claim(p: ClaimParams): Promise<void> {
  const wanted = p.email === undefined ? undefined : normaliseInvitationEmail(p.email)
  if (p.email !== undefined && wanted === null) throw new ClaimRefusal(`--email ${p.email} is not a valid address`)
  const system = (await p.crm.prepare("select id from principals where kind = 'system' limit 1").first()) as {
    id: string
  } | null
  if (!system)
    throw new ClaimRefusal(
      "claim needs the organisation's system principal as the audit actor: the CRM database has none (apply wrote no event, so none was made). Create it with bootstrap, or issue the link with owner-reset",
    )
  let targets = await targetsOf(p.plan, p.control)
  if (wanted !== undefined) {
    const hit = targets.find((t) => t.email.toLowerCase() === wanted)
    if (!hit)
      throw new ClaimRefusal(
        `--email ${wanted} is not a claim target: only people the plan migrates and agent accounts it relinks get a link`,
      )
    if (hit.claimed)
      throw new ClaimRefusal(
        `${wanted} is already claimed (it has a password or a Google account): no link is issued. A claimed account recovers through users.issue_reset_link, or owner-reset for an owner`,
      )
    targets = [hit]
  }
  const todo = targets.filter((t) => !t.claimed)

  p.log(
    `claim: ${targets.length} target${targets.length === 1 ? '' : 's'}: ${todo.length} to issue, ${targets.length - todo.length} already claimed`,
  )
  for (const l of capsLines(p.plan)) p.log(l)
  for (const t of targets.filter((x) => x.claimed))
    p.log(
      `already claimed: ${t.email} (${label(t)}): no link; a claimed account recovers through users.issue_reset_link or owner-reset`,
    )
  if (todo.length === 0) {
    p.log('nothing to issue')
    return
  }
  if (p.dryRun) {
    for (const t of todo) p.log(`dry run: would issue a link for ${t.email} (${label(t)})`)
    p.log('dry run: nothing was written')
    return
  }

  const issued: string[] = []
  for (const [i, t] of todo.entries()) {
    const rest = todo.slice(i).map((x) => x.email)
    const tail = `links were issued for: ${issued.join(', ') || 'nobody'}; not issued: ${rest.join(', ')}; run claim again (or pass --email <address> for one)`
    let link: Awaited<ReturnType<typeof issueResetLink>>
    try {
      link = await issueResetLink({
        control: p.control,
        baseUrl: p.baseUrl,
        authSecret: p.authSecret,
        email: t.email,
        subject: t.subject,
        actorId: system.id,
        via: CLAIM_VIA,
        now: p.now(),
        newAuditId: p.newId,
      })
    } catch (e) {
      throw new ClaimFailure(
        e instanceof ResetAuditError
          ? `claim failed for ${t.email}: its reset link was not recorded in the audit log (${message(e)}), so it was not printed; the unused link expires. ${tail}`
          : `claim failed for ${t.email}: its reset link could not be issued (${message(e)}). ${tail}`,
      )
    }
    if (!link)
      throw new ClaimFailure(
        `claim failed for ${t.email}: no Better Auth account answers to that address although the instance reads as applied. ${tail}`,
      )
    p.log(`claim link for ${t.email} (${label(t)}; expires ${link.expiresAt}; shown once, stored nowhere): ${link.url}`)
    issued.push(t.email)
  }
  p.log(`claim: ${issued.length} link${issued.length === 1 ? '' : 's'} issued, each valid for one hour`)
}
