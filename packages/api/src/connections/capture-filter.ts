import { normalizeIdentityValue } from '../identity/normalize.js'
import type { CaptureParticipant } from '../messaging/capture.js'
import type { ExcludeFacts, ExcludeHook } from '../messaging/pipeline.js'
import type { CaptureSettings } from './capture-settings.js'

/**
 * Sender filters ([[CHN407]] D5-D10): the predicate a capture page hands the pipeline's `exclude` hook. Built once per page from the settings the page
 * already read and the connection's mailbox; a pure function of a message's normalised participants. The lists are spec text (D9): changing either is a
 * changelog entry in [[CHN407]] and an edit to the pinning test.
 */

/** A group address's local part, with any `+tag` removed, is one of these ([[CHN407]] D9)... */
export const GROUP_ADDRESS_NAMES: readonly string[] = [
  'admin',
  'billing',
  'bounce',
  'bounces',
  'careers',
  'contact',
  'enquiries',
  'feedback',
  'hello',
  'help',
  'hr',
  'info',
  'inquiries',
  'jobs',
  'mailer-daemon',
  'marketing',
  'news',
  'newsletter',
  'notification',
  'notifications',
  'office',
  'postmaster',
  'press',
  'sales',
  'security',
  'service',
  'support',
  'team',
  'updates',
]
/** ...or begins with one of these. */
export const GROUP_ADDRESS_PREFIXES: readonly string[] = [
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
]
/** Exact domains, never subdomains ([[CHN407]] D9). */
export const PERSONAL_MAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'zoho.com',
  'tutanota.com',
  'qq.com',
  '163.com',
  '126.com',
]

export type CaptureFilterSettings = Pick<
  CaptureSettings,
  'blocked_addresses' | 'blocked_domains' | 'exclude_group_addresses' | 'exclude_personal_domains'
>

const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1)
const localPartOf = (address: string): string => {
  const local = address.slice(0, address.lastIndexOf('@'))
  const plus = local.indexOf('+')
  return plus === -1 ? local : local.slice(0, plus)
}
const isGroupAddress = (address: string): boolean => {
  const local = localPartOf(address)
  return GROUP_ADDRESS_NAMES.includes(local) || GROUP_ADDRESS_PREFIXES.some((p) => local.startsWith(p))
}
const personal = new Set(PERSONAL_MAIL_DOMAINS)
const isPersonalDomain = (address: string): boolean => personal.has(domainOf(address))

/** A refusal reason per D10's order, or null. `mailbox` is normalised as participants are (P2). */
export function captureFilter(settings: CaptureFilterSettings, mailbox: string): ExcludeHook {
  const ownMailbox = normalizeIdentityValue('email', mailbox)
  const addresses = new Set(settings.blocked_addresses)
  const domains = settings.blocked_domains
  const blocked = (address: string): boolean => {
    if (addresses.has(address)) return true
    const domain = domainOf(address)
    return domains.some((d) => domain === d || domain.endsWith(`.${d}`))
  }
  // D8: the other party is the `from` counterparty of a received message, every recipient counterparty of a sent one.
  const refusedByOtherParty = (
    facts: ExcludeFacts,
    counterparties: readonly CaptureParticipant[],
    excluded: (address: string) => boolean,
  ): boolean => {
    const others = facts.sent_by_connection
      ? counterparties.filter((p) => p.role !== 'from')
      : counterparties.filter((p) => p.role === 'from')
    return others.length > 0 && others.every((p) => excluded(p.value))
  }
  return (facts) => {
    // D6: the own side is the mailbox, plus every `from` of a message the connection sent (a send-as alias). Phone participants are ignored.
    const own = new Set([ownMailbox])
    if (facts.sent_by_connection) for (const p of facts.participants) if (p.role === 'from') own.add(p.value)
    const counterparties = facts.participants.filter((p) => p.kind === 'email' && !own.has(p.value))
    if (counterparties.some((p) => blocked(p.value))) return 'blocked'
    if (settings.exclude_group_addresses && refusedByOtherParty(facts, counterparties, isGroupAddress))
      return 'group_address'
    if (settings.exclude_personal_domains && refusedByOtherParty(facts, counterparties, isPersonalDomain))
      return 'personal_domain'
    return null
  }
}
