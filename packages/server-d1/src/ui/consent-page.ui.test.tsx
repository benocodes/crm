// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SCOPE_DESCRIPTIONS } from '@vibase/api/scope-descriptions'
import { ConsentPage } from './consent-page.js'
import { fakeFetch } from './fake-fetch.js'
import { MESSAGES, consentReturnsTo, genericFailure } from './messages.js'

// [[UI247]] D4: the consent page. The signed query goes back verbatim; the page never builds or edits one.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
// Encoded characters, a repeated key and an order the page must not touch.
const QUERY =
  'state=a%20b%2Bc&sig=Ab%2Fc%3D%3D&scope=openid+contacts%3Aread&client_id=app-1&redirect_uri=https%3A%2F%2Fclient.test%2Fcb%3Fx%3D1&exp=1999999999&scope=dup'
const at = (q: string) => history.replaceState(null, '', q === '' ? '/app/consent' : `/app/consent?${q}`)
beforeEach(() => at(QUERY))

const NO_SESSION = { status: 200, json: null }
const SESSION = { status: 200, json: { user: { id: 'u1', email: 'ann@x.test' }, session: { id: 's1' } } }
const CLIENT = { status: 200, json: { client_id: 'app-1', client_name: 'Claude Desktop' } }
// [[CORE673]]: the page reads what the account may approve; the suites' default is an owner, who holds everything the fixtures ask for.
const OWNER_BOUND = { status: 200, json: { kind: 'person', scopes: Object.keys(SCOPE_DESCRIPTIONS) } }
const routes = (over: Record<string, { status: number; json?: unknown; text?: string }> = {}) => ({
  'GET /auth/get-session': SESSION,
  'GET /auth/consent-bound': OWNER_BOUND,
  'GET /auth/oauth2/public-client': CLIENT,
  'POST /auth/oauth2/consent': {
    status: 200,
    json: { redirect: true, url: 'https://client.test/cb?code=c&state=a%20b%2Bc' },
  },
  ...over,
})
const allow = async () => userEvent.setup().click(await screen.findByRole('button', { name: /allow/i }))
const deny = async () => userEvent.setup().click(await screen.findByRole('button', { name: /deny/i }))

describe('a request that is not an authorization request', () => {
  it.each([
    ['no query at all', ''],
    ['no sig', 'client_id=app-1&scope=openid'],
    ['no client_id', 'sig=abc&scope=openid'],
  ])('%s: an explanation, no buttons, nothing sent', async (_n, q) => {
    at(q)
    const f = fakeFetch(routes())
    render(<ConsentPage />)
    expect(await screen.findByText(MESSAGES.consentNoRequest)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(f.requests()).toEqual([])
  })
})

describe('no session', () => {
  it('goes to /sign-in with the very same query', async () => {
    fakeFetch(routes({ 'GET /auth/get-session': NO_SESSION }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await waitFor(() => expect(go).toHaveBeenCalledWith(`/app/sign-in?${QUERY}`))
    expect(screen.queryByRole('button', { name: /allow/i })).toBeNull()
  })
})

describe('signed in', () => {
  it("shows the email, the app's name with the unverified line, the redirect host and the scopes as text", async () => {
    fakeFetch(routes())
    render(<ConsentPage />)
    expect(await screen.findByText('Signed in as ann@x.test')).toBeTruthy()
    expect(await screen.findByText('Claude Desktop')).toBeTruthy()
    expect(screen.getByText(MESSAGES.consentUnverified)).toBeTruthy()
    expect(screen.getByText(consentReturnsTo('client.test'))).toBeTruthy()
    // [[UI455]]: the scopes sit inside closed disclosures, as text.
    expect(screen.getByText('contacts:read')).toBeTruthy()
    expect(screen.getByText(SCOPE_DESCRIPTIONS['contacts:read']!)).toBeTruthy()
    expect(screen.getByText('openid')).toBeTruthy()
    expect(document.querySelectorAll('details[open]').length).toBe(0)
  })

  it('the redirect host includes a port', async () => {
    at(QUERY.replace('https%3A%2F%2Fclient.test%2Fcb%3Fx%3D1', 'http%3A%2F%2F127.0.0.1%3A33418%2Fcb'))
    fakeFetch(routes())
    render(<ConsentPage />)
    expect(await screen.findByText(consentReturnsTo('127.0.0.1:33418'))).toBeTruthy()
  })

  it('a missing or unparsable redirect_uri shows no "go back to" line, and the buttons stay', async () => {
    at('client_id=app-1&scope=openid&sig=s&redirect_uri=not%20a%20url')
    fakeFetch(routes())
    render(<ConsentPage />)
    await screen.findByText('Claude Desktop')
    expect(document.body.textContent).not.toContain('After you allow')
    expect(screen.getByRole('button', { name: /allow/i })).toBeTruthy()
  })

  it('an app name, email and scope holding markup are text: no element is created', async () => {
    at('client_id=app-1&scope=%3Cu%3Ex%3C%2Fu%3E&sig=s&redirect_uri=https%3A%2F%2Fclient.test%2Fcb')
    fakeFetch(
      routes({
        'GET /auth/get-session': { status: 200, json: { user: { id: 'u', email: '<i id="e">a</i>@x.test' } } },
        'GET /auth/oauth2/public-client': { status: 200, json: { client_name: '<b id="n">Evil</b>' } },
      }),
    )
    render(<ConsentPage />)
    await screen.findByText('<b id="n">Evil</b>')
    expect(screen.getByText('Signed in as <i id="e">a</i>@x.test')).toBeTruthy()
    expect(screen.getAllByText('<u>x</u>').length).toBeGreaterThan(0)
    expect(document.querySelector('u')).toBeNull()
    for (const id of ['n', 'e']) expect(document.getElementById(id), id).toBeNull()
  })

  it('a failed name lookup falls back to the client id as text', async () => {
    fakeFetch(routes({ 'GET /auth/oauth2/public-client': { status: 404, json: { error: 'not_found' } } }))
    render(<ConsentPage />)
    expect(await screen.findByText('app-1')).toBeTruthy()
  })

  it('"Use another account" signs out and goes to /sign-in with the same query', async () => {
    const f = fakeFetch({ ...routes(), 'POST /auth/sign-out': { status: 200, json: { success: true } } })
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: MESSAGES.useAnotherAccount }))
    await waitFor(() => expect(go).toHaveBeenCalledWith(`/app/sign-in?${QUERY}`))
    expect(f.requests()).toContain('POST /auth/sign-out')
  })
})

describe('Allow and Deny', () => {
  it('oauth_query is location.search without "?", byte for byte, and scope is always sent ([[UI455]] D6)', async () => {
    const f = fakeFetch(routes())
    render(<ConsentPage navigate={vi.fn()} />)
    await allow()
    await waitFor(() => expect(f.calls.some((c) => c.path === '/auth/oauth2/consent')).toBe(true))
    const body = f.calls.find((c) => c.path === '/auth/oauth2/consent')!.body as Record<string, unknown>
    expect(body).toEqual({ accept: true, oauth_query: location.search.slice(1), scope: 'openid contacts:read' })
    expect(body.oauth_query).toBe(QUERY)
  })

  it('Deny sends accept: false with the same query and follows the answered redirect', async () => {
    const f = fakeFetch(
      routes({
        'POST /auth/oauth2/consent': {
          status: 200,
          json: { redirect: true, url: 'https://client.test/cb?error=access_denied' },
        },
      }),
    )
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await deny()
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://client.test/cb?error=access_denied'))
    expect(f.calls.find((c) => c.path === '/auth/oauth2/consent')!.body).toEqual({ accept: false, oauth_query: QUERY })
  })

  it.each(['https://client.test/cb?code=c', 'http://127.0.0.1:33418/cb?code=c', '/app/consent?x=1'])(
    'the redirect %s is followed',
    async (url) => {
      fakeFetch(routes({ 'POST /auth/oauth2/consent': { status: 200, json: { redirect: true, url } } }))
      const go = vi.fn()
      render(<ConsentPage navigate={go} />)
      await allow()
      await waitFor(() => expect(go).toHaveBeenCalledWith(url))
    },
  )

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>'])(
    'the redirect %s is refused: nothing navigates and a generic error shows',
    async (url) => {
      fakeFetch(routes({ 'POST /auth/oauth2/consent': { status: 200, json: { redirect: true, url } } }))
      const go = vi.fn()
      render(<ConsentPage navigate={go} />)
      await allow()
      expect((await screen.findByRole('alert')).textContent).toBe(genericFailure(200))
      expect(go).not.toHaveBeenCalled()
    },
  )

  it('an answer without a redirect is the generic error, not a navigation', async () => {
    fakeFetch(routes({ 'POST /auth/oauth2/consent': { status: 200, json: { ok: true } } }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await allow()
    expect((await screen.findByRole('alert')).textContent).toBe(genericFailure(200))
    expect(go).not.toHaveBeenCalled()
  })

  const failures: Array<[string, { status: number; json?: unknown; text?: string }, string]> = [
    ['invalid_signature', { status: 400, json: { error: 'invalid_signature' } }, MESSAGES.consentInvalid],
    [
      'an expired or lost query (400 invalid_request)',
      { status: 400, json: { error: 'invalid_request', error_description: 'missing oauth query' } },
      MESSAGES.consentInvalid,
    ],
    ['429', { status: 429, json: {} }, MESSAGES.rateLimited],
    ['a generic failure', { status: 500, text: 'boom' }, genericFailure(500)],
  ]
  it.each(failures)("%s gets its message, not the server's", async (_n, reply, message) => {
    fakeFetch(routes({ 'POST /auth/oauth2/consent': reply }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await allow()
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(go).not.toHaveBeenCalled()
  })

  it('a 401 sends the person to /sign-in with the same query', async () => {
    fakeFetch(routes({ 'POST /auth/oauth2/consent': { status: 401, json: { message: 'Unauthorized' } } }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await allow()
    await waitFor(() => expect(go).toHaveBeenCalledWith(`/app/sign-in?${QUERY}`))
  })
})

// [[UI455]] groups 2 to 4: the switches, what Allow and Deny send, and the rendering.
const DEFAULT_QUERY = `client_id=app-1&sig=s&redirect_uri=https%3A%2F%2Fclient.test%2Fcb&scope=${encodeURIComponent(
  'openid profile email offline_access contacts:read contacts:request_approval contacts:write companies:read interactions:read messages:read messages:write events:read webhooks:read webhooks:write',
)}`
const consentBody = (f: ReturnType<typeof fakeFetch>) =>
  f.calls.find((c) => c.path === '/auth/oauth2/consent')!.body as Record<string, unknown>
const sw = (area: string, name: string | RegExp) =>
  screen.findByRole('switch', {
    name: typeof name === 'string' ? `${area} ${name}` : new RegExp(`^${area} ${name.source}`),
  })
const WRITE_CRM = ['CRM records', 'Write'] as const
const PROPOSE_CRM = ['CRM records', 'Propose changes for approval'] as const

describe('the switches (group 2)', () => {
  beforeEach(() => at(DEFAULT_QUERY))

  it('shows the sign-in line once and the four areas, defaults read and propose on, write off, no Administration', async () => {
    fakeFetch(routes())
    render(<ConsentPage navigate={vi.fn()} />)
    await sw('CRM records', 'Read')
    expect([...document.querySelectorAll('fieldset')].map((g) => g.querySelector('legend')?.textContent)).toEqual([
      'CRM records',
      'Messages',
      'Activity and approvals',
      'Integrations',
    ])
    expect(screen.queryByText('Administration')).toBeNull()
    expect((await sw(...WRITE_CRM)).getAttribute('aria-checked')).toBe('false')
    expect((await sw(...PROPOSE_CRM)).getAttribute('aria-checked')).toBe('true')
    expect((await sw('CRM records', 'Read')).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryAllByRole('switch').length).toBe(3 + 2 + 1 + 2)
  })

  it('Write on forces Propose on and disabled with the note, and the body holds request_approval and write; Read is unaffected', async () => {
    const f = fakeFetch(routes())
    render(<ConsentPage navigate={vi.fn()} />)
    const u = userEvent.setup()
    await u.click(await sw(...WRITE_CRM))
    const propose = await sw(...PROPOSE_CRM)
    expect(propose.getAttribute('aria-checked')).toBe('true')
    expect((propose as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Writing includes proposing changes for approval.')).toBeTruthy()
    expect((await sw('CRM records', 'Read')).getAttribute('aria-checked')).toBe('true')
    await allow()
    await waitFor(() => expect(consentBody(f)).toBeTruthy())
    const scope = String(consentBody(f).scope).split(' ')
    expect(scope).toEqual(expect.arrayContaining(['contacts:request_approval', 'contacts:write', 'contacts:read']))
  })

  it('Write on over a Propose the owner had turned off still sends request_approval, with Propose shown on', async () => {
    const f = fakeFetch(routes())
    render(<ConsentPage navigate={vi.fn()} />)
    const u = userEvent.setup()
    await u.click(await sw(...PROPOSE_CRM))
    await u.click(await sw(...WRITE_CRM))
    expect((await sw(...PROPOSE_CRM)).getAttribute('aria-checked')).toBe('true')
    await allow()
    await waitFor(() => expect(consentBody(f)).toBeTruthy())
    expect(String(consentBody(f).scope).split(' ')).toEqual(
      expect.arrayContaining(['contacts:request_approval', 'contacts:write']),
    )
  })

  it.each([
    ['from Propose on', false],
    ['from a Propose the owner turned off first', true],
  ])('Write off releases Propose to its previous state %s', async (_n, proposeOffFirst) => {
    const f = fakeFetch(routes())
    render(<ConsentPage navigate={vi.fn()} />)
    const u = userEvent.setup()
    if (proposeOffFirst) await u.click(await sw(...PROPOSE_CRM))
    await u.click(await sw(...WRITE_CRM))
    await u.click(await sw(...WRITE_CRM))
    const propose = await sw(...PROPOSE_CRM)
    expect(propose.getAttribute('aria-checked')).toBe(proposeOffFirst ? 'false' : 'true')
    expect((propose as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('Writing includes proposing changes for approval.')).toBeNull()
    await allow()
    await waitFor(() => expect(consentBody(f)).toBeTruthy())
    const scope = String(consentBody(f).scope).split(' ')
    expect(scope).not.toContain('contacts:write')
    expect(scope.includes('contacts:request_approval')).toBe(!proposeOffFirst)
  })
})

describe('Allow and Deny send what the page shows (group 3)', () => {
  it('a switch changed just before Allow changes the body; Read off drops the area reads', async () => {
    at(DEFAULT_QUERY)
    const f = fakeFetch(routes())
    render(<ConsentPage navigate={vi.fn()} />)
    await userEvent.setup().click(await sw('Messages', 'Read'))
    await allow()
    await waitFor(() => expect(consentBody(f)).toBeTruthy())
    expect(consentBody(f)).toEqual({
      accept: true,
      oauth_query: DEFAULT_QUERY,
      scope:
        'openid profile email offline_access contacts:read contacts:request_approval companies:read events:read webhooks:read',
    })
  })

  it('Deny sends { accept: false, oauth_query } and no scope key', async () => {
    at(DEFAULT_QUERY)
    const f = fakeFetch(routes())
    render(<ConsentPage navigate={vi.fn()} />)
    await deny()
    await waitFor(() => expect(consentBody(f)).toBeTruthy())
    expect(consentBody(f)).toEqual({ accept: false, oauth_query: DEFAULT_QUERY })
    expect('scope' in consentBody(f)).toBe(false)
  })

  it('every switch off with no sign-in scope: Allow disabled, one hint, nothing sent; one switch on restores it', async () => {
    at('client_id=app-1&sig=s&scope=contacts%3Aread+companies%3Aread')
    const f = fakeFetch(routes())
    render(<ConsentPage navigate={vi.fn()} />)
    const u = userEvent.setup()
    const read = await sw('CRM records', 'Read')
    const hint = 'Switch something on to allow access, or choose Deny.'
    expect(screen.queryByText(hint)).toBeNull()
    await u.click(read)
    expect(screen.getByText(hint)).toBeTruthy()
    const button = screen.getByRole('button', { name: /allow/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await u.click(button)
    expect(f.calls.some((c) => c.path === '/auth/oauth2/consent')).toBe(false)
    await u.click(read)
    expect(screen.queryByText(hint)).toBeNull()
    expect(button.disabled).toBe(false)
    await u.click(read)
    expect(screen.getByText(hint)).toBeTruthy()
  })

  it("a failed Allow's message survives a switch change and clears on the next press", async () => {
    at(DEFAULT_QUERY)
    let n = 0
    fakeFetch({
      ...routes(),
      'POST /auth/oauth2/consent': () =>
        ++n === 1
          ? { status: 500, text: 'boom' }
          : { status: 200, json: { redirect: true, url: 'https://client.test/cb?code=c' } },
    })
    render(<ConsentPage navigate={vi.fn()} />)
    const u = userEvent.setup()
    await allow()
    expect((await screen.findByRole('alert')).textContent).toBe(genericFailure(500))
    await u.click(await sw('CRM records', 'Read'))
    expect(screen.getByRole('alert').textContent).toBe(genericFailure(500))
    await allow()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('rendered as text and accessible (group 4)', () => {
  it('areas are fieldset/legend, every switch is named by its label and area, each disclosure counts and lists every requested scope', async () => {
    at(DEFAULT_QUERY)
    fakeFetch(routes())
    const { container } = render(<ConsentPage navigate={vi.fn()} />)
    await sw('CRM records', 'Read')
    expect(container.querySelectorAll('fieldset').length).toBe(4)
    for (const s of screen.getAllByRole('switch')) {
      const fieldset = s.closest('fieldset')!
      expect(s.getAttribute('aria-labelledby'), 'named').toBeTruthy()
      expect(
        s
          .getAttribute('aria-labelledby')!
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent)
          .join(' '),
      ).toContain(fieldset.querySelector('legend')!.textContent!)
    }
    const crm = [...container.querySelectorAll('fieldset')].find(
      (f) => f.querySelector('legend')!.textContent === 'CRM records',
    )!
    expect(crm.querySelector('summary')!.textContent).toBe('Show the 4 permissions')
    for (const n of ['contacts:read', 'contacts:request_approval', 'contacts:write', 'companies:read'])
      expect(crm.textContent).toContain(n)
    expect(document.body.textContent).toContain('Show the 2 permissions')
  })

  it('the sign-in line has no switch, its own disclosure and the D5 sentences', async () => {
    at(DEFAULT_QUERY)
    fakeFetch(routes())
    render(<ConsentPage navigate={vi.fn()} />)
    await sw('CRM records', 'Read')
    const line = screen.getByTestId('sign-in-line')
    expect(line.querySelector('[role="switch"]')).toBeNull()
    expect(line.querySelector('summary')!.textContent).toBe('Show the 4 permissions')
    expect(line.textContent).toContain('Also: confirm who you are and stay signed in')
    expect(line.textContent).toContain('Stay signed in: keep access until you sign out or the access is revoked')
  })

  it('a hostile client name and an unparseable scope with markup are text', async () => {
    at('client_id=app-1&sig=s&scope=%3Cu%3Ex%3C%2Fu%3E+contacts%3Aread')
    fakeFetch(
      routes({ 'GET /auth/oauth2/public-client': { status: 200, json: { client_name: '<b id="n">Evil</b>' } } }),
    )
    render(<ConsentPage navigate={vi.fn()} />)
    await screen.findByText('<b id="n">Evil</b>')
    expect(screen.getAllByText('<u>x</u>').length).toBeGreaterThan(0)
    expect(document.querySelector('u')).toBeNull()
    expect(document.getElementById('n')).toBeNull()
  })

  it('axe is clean on the default-set shape with every disclosure open (region names are unique)', async () => {
    at(DEFAULT_QUERY)
    fakeFetch(routes())
    const { container } = render(<ConsentPage navigate={vi.fn()} />)
    await sw('CRM records', 'Read')
    for (const d of container.querySelectorAll('details')) d.open = true
    const axe = (await import('axe-core')).default
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(' | ')}`)).toEqual([])
    const names = [...container.querySelectorAll('details section')].map((e) => e.getAttribute('aria-label'))
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('CRM records permissions')
  })

  it('axe is clean on the default-set shape', async () => {
    at(DEFAULT_QUERY)
    fakeFetch(routes())
    const { container } = render(<ConsentPage navigate={vi.fn()} />)
    await sw('CRM records', 'Read')
    const axe = (await import('axe-core')).default
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([])
  })
})

// [[CORE673]] D11 (the page): what the approving account cannot approve is off and disabled, with one line by account kind.
describe('the page holds the approving account (CORE673)', () => {
  const QUERY_BOUND =
    'client_id=app-1&sig=s&scope=openid+contacts%3Aread+webhooks%3Aread+messages%3Aread+messages%3Aread_metadata'
  const MEMBER = { status: 200, json: { kind: 'person', scopes: ['contacts:read', 'contacts:write'] } }
  const AGENT = { status: 200, json: { kind: 'agent', scopes: ['contacts:read', 'messages:read_metadata'] } }
  const isDisabled = (el: HTMLElement) =>
    (el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled')
  beforeEach(() => at(QUERY_BOUND))

  it.each([
    ['a person', MEMBER, "Your role in this workspace doesn't include this"],
    ['an agent account', AGENT, "This agent account hasn't been granted this"],
  ])(
    '%s: a switch outside the bound is off and disabled with its line; a held one is enabled',
    async (_n, bound, line) => {
      fakeFetch(routes({ 'GET /auth/consent-bound': bound }))
      render(<ConsentPage navigate={vi.fn()} />)
      const integrations = await sw('Integrations', 'Read')
      expect(isDisabled(integrations)).toBe(true)
      expect(integrations.getAttribute('aria-checked')).toBe('false')
      expect(screen.getAllByText(line).length).toBeGreaterThan(0)
      expect(isDisabled(await sw('CRM records', 'Read'))).toBe(false)
    },
  )

  it('a partly-held switch is enabled and Allow sends only its held scopes', async () => {
    const f = fakeFetch(routes({ 'GET /auth/consent-bound': AGENT }))
    render(<ConsentPage navigate={vi.fn()} />)
    expect(isDisabled(await sw('Messages', 'Read'))).toBe(false)
    await allow()
    await waitFor(() => expect(consentBody(f)).toBeTruthy())
    expect(consentBody(f).scope).toBe('openid contacts:read messages:read_metadata')
  })

  it('every switch disabled: Allow is disabled and Deny still answers the client', async () => {
    at('client_id=app-1&sig=s&scope=openid+webhooks%3Aread')
    const f = fakeFetch(routes({ 'GET /auth/consent-bound': MEMBER }))
    render(<ConsentPage navigate={vi.fn()} />)
    await sw('Integrations', 'Read')
    const button = screen.getByRole('button', { name: /allow/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await userEvent.setup().click(button)
    expect(f.calls.some((c) => c.path === '/auth/oauth2/consent')).toBe(false)
    await deny()
    await waitFor(() => expect(consentBody(f)).toEqual({ accept: false, oauth_query: location.search.slice(1) }))
  })

  it('a failing read: the page says it could not load, offers no Allow, and Deny stays', async () => {
    const f = fakeFetch(routes({ 'GET /auth/consent-bound': { status: 500, json: {} } }))
    render(<ConsentPage navigate={vi.fn()} />)
    expect(await screen.findByText(MESSAGES.consentBoundFailed)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /allow/i })).toBeNull()
    await deny()
    await waitFor(() => expect(consentBody(f)).toEqual({ accept: false, oauth_query: location.search.slice(1) }))
  })

  it('a disabled Write never forces Propose on the page', async () => {
    at('client_id=app-1&sig=s&scope=contacts%3Aread+contacts%3Arequest_approval+contacts%3Awrite')
    fakeFetch(
      routes({ 'GET /auth/consent-bound': { status: 200, json: { kind: 'person', scopes: ['contacts:read'] } } }),
    )
    render(<ConsentPage navigate={vi.fn()} />)
    const write = await sw('CRM records', 'Write')
    expect(isDisabled(write)).toBe(true)
    expect((await sw('CRM records', /Propose/)).getAttribute('aria-checked')).toBe('false')
    expect(document.body.textContent).not.toContain(MESSAGES.writeIncludesPropose)
  })

  it('axe is clean with disabled switches', async () => {
    fakeFetch(routes({ 'GET /auth/consent-bound': MEMBER }))
    const { container } = render(<ConsentPage navigate={vi.fn()} />)
    await sw('Integrations', 'Read')
    const axe = (await import('axe-core')).default
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(' | ')}`)).toEqual([])
  })
})
