// @vitest-environment happy-dom
// [[AGT588]] D12: the card leads with the server's words (the summary), then the proposer and the sending mailbox, then the proposer's reason, labelled,
// clamped with an expand control and with the bidi controls removed. Everything reaches the DOM as text nodes.
import { beforeEach, describe, expect, it } from 'vitest'
import { STRIPPED_INVISIBLE_RANGES } from '../../api/src/channels/invisible-characters.js'
import { run } from './app.js'
import { stripInvisible } from './invisible.js'
import { CONFIG, fakeFetch, fakeLocation, settle } from './test-kit.js'

const NOW = Date.now()
const base = {
  id: '0190b2c4-0000-7000-8000-000000000001',
  operation: 'tasks.update',
  arguments: { id: 't1', title: 'x' },
  edited_arguments: null,
  status: 'pending',
  reason: 'because',
  evidence: [],
  contact_id: null,
  thread_id: null,
  expires_at: new Date(NOW + 86_400_000).toISOString(),
  decided_at: null,
  decision_reason: null,
  error_code: null,
  error_message: null,
  created_by: '0190b2c4-0000-7000-8000-0000000000aa',
  created_at: new Date(NOW - 60_000).toISOString(),
  target_summary: 'Update tasks record "T 1" (fields: title)',
  proposer_kind: 'agent',
  proposer_name: 'ui388-p-1',
  proposer_acting_for: null,
  sending_mailbox: null,
}
const root = () => document.getElementById('app')!
async function show(over: Record<string, unknown>) {
  const f = fakeFetch({
    'GET /.well-known/vibase': { auth: { provider: 'better-auth' } },
    'GET /auth/get-session': { user: { email: 'owner@e2e.test' }, session: { id: 's1' } },
    'GET /auth/token': { token: 'jwt-1' },
    'GET /api/v1/action-requests': { data: [{ ...base, ...over }], next_cursor: null },
  })
  await run(root(), { config: CONFIG, fetch: f.fetch, location: fakeLocation().location })
  await settle()
  return root().querySelector('article.card') as HTMLElement
}
const text = (el: Element | null) => el?.textContent ?? ''
beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>'
})

describe('the card (D12)', () => {
  it("leads with the summary as its headline, then the proposer, and the proposer's reason comes after both", async () => {
    const card = await show({})
    expect(text(card.querySelector('h2'))).toBe('Update tasks record "T 1" (fields: title)')
    const order = [...card.children].map((c) => c.className || c.tagName.toLowerCase())
    const at = (cls: string) => order.findIndex((c) => c.split(' ').includes(cls))
    expect(at('proposer')).toBeGreaterThan(-1)
    expect(at('reason')).toBeGreaterThan(at('proposer'))
    const headline = [...card.children].findIndex((c) => c.querySelector('h2'))
    expect(headline).toBe(0)
  })

  it('names the proposer by kind and name, with "acting for" a member when set', async () => {
    let card = await show({})
    expect(text(card.querySelector('.proposer'))).toBe('Proposed by agent ui388-p-1')
    card = await show({ proposer_acting_for: 'Mia M' })
    expect(text(card.querySelector('.proposer'))).toBe('Proposed by agent ui388-p-1, acting for Mia M')
    card = await show({ proposer_kind: 'user', proposer_name: 'Hana H' })
    expect(text(card.querySelector('.proposer'))).toBe('Proposed by user Hana H')
    card = await show({ proposer_kind: 'system', proposer_name: null })
    expect(text(card.querySelector('.proposer'))).toBe('Proposed by the system')
  })

  it('a send shows the sending mailbox after the proposer; other requests show none', async () => {
    let card = await show({
      operation: 'messages.send',
      sending_mailbox: 'owner@example.test',
      arguments: { mode: 'new', to: ['a@b.test'], subject: 's', body: 'b' },
    })
    const mailbox = card.querySelector('.mailbox')!
    expect(text(mailbox)).toBe('Sends from owner@example.test')
    expect(card.children).toContain(mailbox)
    expect([...card.children].indexOf(mailbox)).toBeGreaterThan(
      [...card.children].indexOf(card.querySelector('.proposer')!),
    )
    // the messages.send detail stays
    expect(text(card)).toContain('Subject')
    card = await show({})
    expect(card.querySelector('.mailbox')).toBeNull()
  })

  it("the reason is labelled as the proposer's and has its bidi controls and zero-width characters removed", async () => {
    const card = await show({ reason: '‮evil​ reason⁦' })
    const reason = card.querySelector('.reason')!
    expect(text(reason)).toContain("Proposer's reason")
    expect(text(reason)).toContain('evil reason')
    expect(text(reason)).not.toMatch(/[‮​⁦]/)
    expect(text(card)).not.toMatch(/[‮​⁦]/)
  })

  it('a long reason is clamped with an expand control that toggles it; a short one has no control', async () => {
    let card = await show({ reason: 'short' })
    expect(card.querySelector('.reason button')).toBeNull()
    card = await show({ reason: 'long '.repeat(200) })
    const body = card.querySelector('.reason-text')!
    expect(body.classList.contains('clamped')).toBe(true)
    const toggle = card.querySelector('.reason button') as HTMLButtonElement
    expect(toggle.textContent).toBe('Show more')
    toggle.click()
    expect(card.querySelector('.reason-text')!.classList.contains('clamped')).toBe(false)
    expect(card.querySelector('.reason button')!.textContent).toBe('Show less')
  })

  it('a NULL summary shows the operation instead, and a record without proposer fields still renders', async () => {
    const card = await show({
      target_summary: null,
      proposer_kind: undefined,
      proposer_name: undefined,
      proposer_acting_for: undefined,
      sending_mailbox: undefined,
    })
    expect(text(card.querySelector('h2'))).toBe('Update task')
    expect(text(card)).toContain('tasks.update')
    expect(card.querySelector('.proposer')).toBeNull()
  })

  it('renders hostile text as text, never as markup', async () => {
    const card = await show({ target_summary: '<img src=x onerror=alert(1)>', reason: '<b>bold</b>' })
    expect(card.querySelector('img')).toBeNull()
    expect(card.querySelector('.reason b')).toBeNull()
    expect(text(card.querySelector('h2'))).toBe('<img src=x onerror=alert(1)>')
  })
})

describe("the app's copy of the character rule is pinned to the API's", () => {
  it("removes exactly the API's stripped set, code point by code point, and keeps what the API keeps", () => {
    for (const [lo, hi] of STRIPPED_INVISIBLE_RANGES)
      for (let cp = lo; cp <= hi; cp++)
        expect(stripInvisible(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe('ab')
    const kept = [
      0x200c, 0x200d, 0x200e, 0x200f, 0x061c, 0xfe00, 0xfe0f, 0x2029, 0x00ad, 0x1f600, 0xe0080, 0xe00ff, 0xe01f0,
    ]
    for (const cp of kept)
      expect(stripInvisible(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(`a${String.fromCodePoint(cp)}b`)
    // the code points just outside each range stay
    for (const [lo, hi] of STRIPPED_INVISIBLE_RANGES) {
      const edge = (cp: number) => !STRIPPED_INVISIBLE_RANGES.some(([l, h]) => cp >= l && cp <= h)
      for (const cp of [lo - 1, hi + 1].filter(edge))
        expect(stripInvisible(String.fromCodePoint(cp))).toBe(String.fromCodePoint(cp))
    }
  })
})
