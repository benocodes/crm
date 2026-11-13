// Test-only ([[CHN5]] D35). The synthetic Gmail fixtures, built to the documented `format=full` shape from RFC 822 samples. Real
// recordings join them at the user-gated smoke. Each is a `MessageSpec` so a test can adjust one field.
import { bytesOf } from './channels.js'
import { buildGmailMessage, type BuiltGmailMessage, type MessageSpec } from './gmail.js'

export const MAILBOX = 'owner@vibase.test'
const base = (id: string, extra: Partial<MessageSpec> & Pick<MessageSpec, 'payload'>, headers: Array<[string, string]> = []): MessageSpec => ({
  id,
  headers: [
    ['From', 'Jane Roe <jane@acme.test>'],
    ['To', MAILBOX],
    ['Subject', `Subject of ${id}`],
    ['Date', 'Thu, 22 Oct 2026 09:00:00 +0000'],
    ['Message-ID', `<${id}@acme.test>`],
    ...headers,
  ],
  ...extra,
})

const TABLE_HTML = '<html><head><style>p { color: red }</style></head><body><h1>Quarterly</h1><table><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Widgets</td><td>3</td></tr><tr><td>Gadgets</td><td>5</td></tr></tbody></table><p>Thanks, <strong>Jane</strong></p></body></html>'

export function gmailSpecs(): Record<string, MessageSpec> {
  return {
    plain: base('plain', { payload: { mimeType: 'text/plain', text: 'Hello Owner,\n\nPlease see below.\nThanks' } }),
    htmlOnly: base('html-only', {
      payload: { mimeType: 'text/html', text: '<html><head><style>p{}</style></head><body><h1>Title</h1><p>Some <em>emphasis</em> and <strong>strong</strong> with <a href="https://example.test/x">a link</a>.</p><blockquote>quoted</blockquote></body></html>' },
    }),
    alternativeTable: base('alt-table', {
      payload: { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', text: 'PLAIN VERSION must not be used' }, { mimeType: 'text/html', text: TABLE_HTML }] },
    }),
    inlineImage: base('inline-image', {
      payload: {
        mimeType: 'multipart/related',
        parts: [
          { mimeType: 'text/html', text: '<p>Logo: <img src="cid:logo1@acme.test" alt="logo"></p>' },
          { mimeType: 'image/png', filename: 'logo.png', attachmentId: 'att-logo', bytes: bytesOf(40, 3), headers: [['Content-Disposition', 'inline; filename="logo.png"'], ['Content-ID', '<logo1@acme.test>']] },
        ],
      },
    }),
    attachment: base('with-attachment', {
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', text: 'Report attached' },
          { mimeType: 'application/pdf', filename: 'report.pdf', attachmentId: 'att-pdf', bytes: bytesOf(300, 5), headers: [['Content-Disposition', 'attachment; filename="report.pdf"']] },
        ],
      },
    }),
    nonAscii: base(
      'non-ascii',
      { payload: { mimeType: 'text/plain', text: 'Grüße ✓' } },
    ),
    noMessageId: {
      id: 'no-message-id',
      headers: [['From', 'Jane Roe <jane@acme.test>'], ['To', MAILBOX], ['Subject', 'No id'], ['Date', 'Thu, 22 Oct 2026 09:00:00 +0000']],
      payload: { mimeType: 'text/plain', text: 'body without a Message-ID' },
    },
    selfAddressed: base('self', {
      labels: ['INBOX', 'SENT'],
      payload: { mimeType: 'text/plain', text: 'a note to myself' },
    }),
    reply: base('reply', { payload: { mimeType: 'text/plain', text: 'Re: hello' } }, [['In-Reply-To', '<c@acme.test>'], ['References', '<a@acme.test> <b@acme.test>\r\n <c@acme.test>']]),
  }
}

/** The non-ASCII fixture's headers need to differ from `base`'s: the From, To, Cc and Subject carry RFC 2047 words and quoting. */
export function nonAsciiSpec(): MessageSpec {
  const spec = gmailSpecs().nonAscii!
  const headers = spec.headers.filter(([k]) => !['From', 'To', 'Subject'].includes(k))
  return {
    ...spec,
    headers: [
      ['From', '=?UTF-8?Q?J=C3=B6rg_M=C3=BCller?= <jorg@bucher.test>'],
      ['To', '"Doe, Jane" <jane@acme.test>, ' + MAILBOX],
      ['Cc', '=?ISO-8859-1?Q?Andr=E9?= <andre@acme.test>'],
      ['Bcc', 'hidden@acme.test'],
      // Two adjacent encoded words with whitespace between them are one run.
      ['Subject', '=?UTF-8?B?R3LDvMOfZSBhdXM=?= =?UTF-8?B?IFrDvHJpY2gg4pyT?='],
      ...headers,
    ],
  }
}

export const FIXTURE_NAMES = ['plain', 'htmlOnly', 'alternativeTable', 'inlineImage', 'attachment', 'nonAscii', 'noMessageId', 'selfAddressed', 'reply'] as const
export type FixtureName = (typeof FIXTURE_NAMES)[number]

export function gmailFixture(name: FixtureName, adjust: (spec: MessageSpec) => MessageSpec = (s) => s): BuiltGmailMessage {
  const spec = name === 'nonAscii' ? nonAsciiSpec() : gmailSpecs()[name]!
  return buildGmailMessage(adjust(spec))
}
export const allGmailFixtures = (): Record<FixtureName, BuiltGmailMessage> => Object.fromEntries(FIXTURE_NAMES.map((n) => [n, gmailFixture(n)])) as Record<FixtureName, BuiltGmailMessage>
