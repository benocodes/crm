import { describe, expect, it } from 'vitest'
import { escapeHtml, invitationMessage, passwordResetMessage } from './message.js'

// [[CORE248]] D6: fixed English text, a plain part and a minimal HTML part, the link in both, the HTML escaped; the only variable content is host, role, link and expiry.
const URL_ = 'https://vibase.test/invite#token=abc_DEF-123'
const base = { host: 'vibase.test', url: URL_, role: 'member', expiresAt: '2026-11-21T10:00:00.000Z' }

describe('invitationMessage', () => {
  it('puts the link in the text and in the HTML, and the host in the subject', () => {
    const m = invitationMessage(base)
    expect(m.subject).toBe("You're invited to Vibase at vibase.test")
    expect(m.text).toContain(URL_)
    expect(m.html).toContain(`href="${URL_}"`)
    expect(m.text).toContain('member')
    expect(m.text).toContain('2026-11-21')
  })

  it('escapes the HTML: a host or link carrying <&" never comes out raw', () => {
    const m = invitationMessage({
      host: 'h<i>.test',
      url: 'https://x.test/invite?a=1&b="2"#token=<t>',
      role: 'member',
      expiresAt: base.expiresAt,
    })
    expect(m.html).not.toMatch(/<i>|<t>|"2"/)
    expect(m.html).toContain('&lt;i&gt;')
    expect(m.html).toContain('&amp;b=&quot;2&quot;')
    expect(m.html).toContain('&lt;t&gt;')
    // the text part is plain text: the link is verbatim there
    expect(m.text).toContain('https://x.test/invite?a=1&b="2"#token=<t>')
  })

  it('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('has no remote resources and no scripts', () => {
    const m = invitationMessage(base)
    expect(m.html).not.toMatch(/<img|<script|<link|src=/i)
  })
})

// [[CORE304]] D6: the reset message, beside the invitation's. Fixed text; the only variable content is the host and the link.
describe('passwordResetMessage', () => {
  const RESET_URL = 'https://vibase.test/reset-password#token=abc_DEF-123'
  const reset = { host: 'vibase.test', url: RESET_URL }

  it('subject names the host; text and HTML carry the link; the one-hour expiry is stated', () => {
    const m = passwordResetMessage(reset)
    expect(m.subject).toBe('Reset your Vibase password at vibase.test')
    expect(m.text).toContain(RESET_URL)
    expect(m.html).toContain(`href="${RESET_URL}"`)
    expect(m.text).toMatch(/1 hour/)
    expect(m.html).toMatch(/1 hour/)
    expect(m.text).toMatch(/ignore this message/)
  })

  it('escapes the HTML: a host or link carrying <&" never comes out raw, the text part keeps the link verbatim', () => {
    const m = passwordResetMessage({ host: 'h<i>.test', url: 'https://x.test/reset-password?a=1&b="2"#token=<t>' })
    expect(m.html).not.toMatch(/<i>|<t>|"2"/)
    expect(m.html).toContain('&lt;i&gt;')
    expect(m.html).toContain('&amp;b=&quot;2&quot;')
    expect(m.html).toContain('&lt;t&gt;')
    expect(m.text).toContain('https://x.test/reset-password?a=1&b="2"#token=<t>')
  })

  it('takes nothing but the host and the link, and has no remote resources or scripts', () => {
    const m = passwordResetMessage({ ...reset, email: 'victim@x.test', name: 'Mallory' } as never)
    for (const part of [m.subject, m.text, m.html]) expect(part).not.toMatch(/victim|Mallory/)
    expect(m.html).not.toMatch(/<img|<script|<link|src=/i)
  })
})
