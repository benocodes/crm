import { describe, expect, it } from 'vitest'
import type { CaptureParticipant } from '../messaging/capture.js'
import {
  captureFilter,
  GROUP_ADDRESS_NAMES,
  GROUP_ADDRESS_PREFIXES,
  PERSONAL_MAIL_DOMAINS,
  type CaptureFilterSettings,
} from './capture-filter.js'

// [[CHN407]] D6-D10 ([[CHN414]] group 1): the pure predicate, one table. Participants are already normalised (lowercase), as the pipeline hands them over.
const MAILBOX = 'owner@acme.test'
type Role = CaptureParticipant['role']
const email = (role: Role, value: string): CaptureParticipant => ({ kind: 'email', value, role })
const from = (v: string) => email('from', v)
const to = (v: string) => email('to', v)
const cc = (v: string) => email('cc', v)
const bcc = (v: string) => email('bcc', v)
const S = (over: Partial<CaptureFilterSettings> = {}): CaptureFilterSettings => ({
  blocked_addresses: [],
  blocked_domains: [],
  exclude_group_addresses: false,
  exclude_personal_domains: false,
  ...over,
})
const GROUPS = S({ exclude_group_addresses: true })
const PERSONAL = S({ exclude_personal_domains: true })

interface Row {
  name: string
  settings: CaptureFilterSettings
  participants: CaptureParticipant[]
  sent?: boolean
  mailbox?: string
  expect: string | null
}
const rows: Row[] = [
  // D7 address and domain entries
  {
    name: 'address entry matches the from exactly',
    settings: S({ blocked_addresses: ['bad@x.test'] }),
    participants: [from('bad@x.test'), to(MAILBOX)],
    expect: 'blocked',
  },
  {
    name: 'address entry does not match a +tag variant',
    settings: S({ blocked_addresses: ['bad@x.test'] }),
    participants: [from('bad+tag@x.test'), to(MAILBOX)],
    expect: null,
  },
  {
    name: 'domain entry matches the equal domain',
    settings: S({ blocked_domains: ['x.test'] }),
    participants: [from('a@x.test'), to(MAILBOX)],
    expect: 'blocked',
  },
  {
    name: 'domain entry matches a subdomain',
    settings: S({ blocked_domains: ['x.test'] }),
    participants: [from('a@mail.x.test'), to(MAILBOX)],
    expect: 'blocked',
  },
  {
    name: 'domain entry does not match a longer name ending the same way',
    settings: S({ blocked_domains: ['x.test'] }),
    participants: [from('a@badx.test'), to(MAILBOX)],
    expect: null,
  },
  {
    name: 'a blocked party in cc refuses',
    settings: S({ blocked_addresses: ['bad@x.test'] }),
    participants: [from('client@y.test'), to(MAILBOX), cc('bad@x.test')],
    expect: 'blocked',
  },
  {
    name: 'a blocked party in bcc refuses',
    settings: S({ blocked_domains: ['x.test'] }),
    participants: [from('client@y.test'), to(MAILBOX), bcc('a@x.test')],
    expect: 'blocked',
  },
  {
    name: 'a blocked recipient of a sent message refuses',
    settings: S({ blocked_addresses: ['bad@x.test'] }),
    participants: [from(MAILBOX), to('bad@x.test')],
    sent: true,
    expect: 'blocked',
  },
  // D6 own side
  {
    name: "the owner's own address blocked never refuses their sent mail to a client",
    settings: S({ blocked_addresses: [MAILBOX] }),
    participants: [from(MAILBOX), to('client@y.test')],
    sent: true,
    expect: null,
  },
  {
    name: "the owner's own domain blocked: sent mail to a client is kept",
    settings: S({ blocked_domains: ['acme.test'] }),
    participants: [from(MAILBOX), to('client@y.test')],
    sent: true,
    expect: null,
  },
  {
    name: "the owner's own domain blocked: a colleague on that domain is a counterparty (internal mail is dropped)",
    settings: S({ blocked_domains: ['acme.test'] }),
    participants: [from('colleague@acme.test'), to(MAILBOX)],
    expect: 'blocked',
  },
  {
    name: 'a send-as alias from on a sent message is own side, blocked or not',
    settings: S({ blocked_addresses: ['alias@other.test'], exclude_personal_domains: true }),
    participants: [from('alias@other.test'), to('client@y.test')],
    sent: true,
    expect: null,
  },
  {
    name: 'a phone participant is ignored',
    settings: S({ blocked_addresses: ['+14155550100'] }),
    participants: [from('jane@y.test'), { kind: 'phone', value: '+14155550100', role: 'to' }],
    expect: null,
  },
  // D8, D9 group addresses
  {
    name: 'noreply-x@ is a group address when the flag is on',
    settings: GROUPS,
    participants: [from('noreply-x@y.test'), to(MAILBOX)],
    expect: 'group_address',
  },
  {
    name: 'noreply-x@ is kept when the flag is off',
    settings: S(),
    participants: [from('noreply-x@y.test'), to(MAILBOX)],
    expect: null,
  },
  {
    name: 'support+eu@ (case and +tag) is a group address',
    settings: GROUPS,
    participants: [from('support+eu@y.test'), to(MAILBOX)],
    expect: 'group_address',
  },
  {
    name: 'a not-listed local part is kept',
    settings: GROUPS,
    participants: [from('supporter@y.test'), to(MAILBOX)],
    expect: null,
  },
  {
    name: 'do-not-reply prefix is a group address',
    settings: GROUPS,
    participants: [from('do-not-reply-billing@y.test'), to(MAILBOX)],
    expect: 'group_address',
  },
  {
    name: "a client's mail cc'ing support@ is kept (D8 judges the from)",
    settings: GROUPS,
    participants: [from('jane@y.test'), to(MAILBOX), cc('support@y.test')],
    expect: null,
  },
  // D8 personal domains
  {
    name: 'a received message from gmail.com is personal when the flag is on',
    settings: PERSONAL,
    participants: [from('jane@gmail.com'), to(MAILBOX)],
    expect: 'personal_domain',
  },
  {
    name: 'a received message from user@mail.gmail.com is not personal (exact domains)',
    settings: PERSONAL,
    participants: [from('user@mail.gmail.com'), to(MAILBOX)],
    expect: null,
  },
  {
    name: 'a sent message to one gmail.com recipient and one client is kept',
    settings: PERSONAL,
    participants: [from(MAILBOX), to('jane@gmail.com'), cc('client@y.test')],
    sent: true,
    expect: null,
  },
  {
    name: 'a sent message to two gmail.com recipients is refused',
    settings: PERSONAL,
    participants: [from(MAILBOX), to('a@gmail.com'), bcc('b@outlook.com')],
    sent: true,
    expect: 'personal_domain',
  },
  {
    name: 'a sent message to a noreply address is refused when the flag is on',
    settings: GROUPS,
    participants: [from(MAILBOX), to('noreply@y.test')],
    sent: true,
    expect: 'group_address',
  },
  {
    name: 'a sent note to self is kept',
    settings: S({ exclude_group_addresses: true, exclude_personal_domains: true }),
    participants: [from(MAILBOX), to(MAILBOX)],
    sent: true,
    expect: null,
  },
  // P3
  {
    name: "P3: a received message from the owner's own address (another client) has no from counterparty, so group and personal do not refuse it",
    settings: S({ exclude_group_addresses: true, exclude_personal_domains: true }),
    participants: [from('owner@gmail.com'), to('client@y.test')],
    mailbox: 'owner@gmail.com',
    expect: null,
  },
  {
    name: 'P3: the blocklist still judges the other counterparties of that message',
    settings: S({ blocked_addresses: ['bad@x.test'] }),
    participants: [from(MAILBOX), to('bad@x.test')],
    expect: 'blocked',
  },
  // P2
  {
    name: 'P2: a mixed-case stored mailbox is still the own side',
    settings: S({ blocked_addresses: ['owner@acme.test'] }),
    participants: [from(MAILBOX), to('client@y.test')],
    sent: true,
    mailbox: ' Owner@ACME.test ',
    expect: null,
  },
  // D10 precedence
  {
    name: 'blocked wins over group_address',
    settings: S({ blocked_addresses: ['noreply@x.test'], exclude_group_addresses: true }),
    participants: [from('noreply@x.test'), to(MAILBOX)],
    expect: 'blocked',
  },
  {
    name: 'group_address wins over personal_domain',
    settings: S({ exclude_group_addresses: true, exclude_personal_domains: true }),
    participants: [from('info@gmail.com'), to(MAILBOX)],
    expect: 'group_address',
  },
]

describe('capture filter predicate (D6-D10)', () => {
  it.each(rows)('$name', (r) => {
    const hook = captureFilter(r.settings, r.mailbox ?? MAILBOX)
    expect(hook({ participants: r.participants, sent_by_connection: r.sent === true })).toBe(r.expect)
  })
})

describe('the fixed lists are the D9 text', () => {
  it('group address names and prefixes', () => {
    expect(GROUP_ADDRESS_NAMES).toEqual([
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
    ])
    expect(GROUP_ADDRESS_PREFIXES).toEqual([
      'noreply',
      'no-reply',
      'no_reply',
      'donotreply',
      'do-not-reply',
      'do_not_reply',
    ])
  })
  it('personal mail domains', () => {
    expect(PERSONAL_MAIL_DOMAINS).toEqual([
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
    ])
    expect(PERSONAL_MAIL_DOMAINS).toHaveLength(30)
  })
})
