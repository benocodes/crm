import { describe, expect, it } from 'vitest'
import { escapeHtml, invitationMessage } from './message.js'

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
