// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeFetch } from './fake-fetch.js'
import { InvitePage } from './invite-page.js'
import { MESSAGES, genericFailure } from './messages.js'

// [[UI246]] D4: the invite page. The token is read from the fragment and removed from the address; no token, no form; the body is exactly { name, email, password, invitation_token };
// every refusal reads as the page's own text; success goes to /sign-in.
const TOKEN = 'tok_ABC-123_xyz'
const PASSWORD = 'a long enough password'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  history.replaceState(null, '', `/invite#token=${TOKEN}`)
})

const fill = async (o: { name?: string; email?: string; password?: string } = {}) => {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Name'), o.name ?? 'Ann Tester')
  await user.type(screen.getByLabelText('Email'), o.email ?? 'ann@x.test')
  await user.type(screen.getByLabelText('Password'), o.password ?? PASSWORD)
  return user
}
const submit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /create account/i }))

describe('the fragment token', () => {
  it('is read from #token= and removed from the address before the form renders', () => {
    const replace = vi.spyOn(history, 'replaceState')
    render(<InvitePage />)
    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(location.hash).toBe('')
    expect(location.href).not.toContain(TOKEN)
    expect(location.pathname).toBe('/invite')
    expect(replace).toHaveBeenCalled()
    expect(String(replace.mock.calls[0]![2])).not.toContain('token')
    replace.mockRestore()
  })

  it.each(['/invite', '/invite#', '/invite#token=', '/invite#other=1'])('%s: an explanation and no form', (url) => {
    history.replaceState(null, '', url)
    fakeFetch({})
    render(<InvitePage />)
    expect(screen.getByText(MESSAGES.inviteNoToken)).toBeTruthy()
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('the form has the three fields with their autocomplete values', () => {
    render(<InvitePage />)
    expect(screen.getByLabelText('Name').getAttribute('autocomplete')).toBe('name')
    expect(screen.getByLabelText('Email').getAttribute('autocomplete')).toBe('email')
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('new-password')
    expect(screen.getByLabelText('Password').getAttribute('type')).toBe('password')
  })
})

describe('client validation sends nothing', () => {
  it.each([
    ['no name', { name: ' ' }, MESSAGES.nameRequired],
    ['an email without a domain', { email: 'ann@' }, MESSAGES.emailInvalid],
    ['an email without @', { email: 'annx.test' }, MESSAGES.emailInvalid],
    ['a 7-character password', { password: '1234567' }, MESSAGES.passwordTooShort],
    ['a 129-character password', { password: 'x'.repeat(129) }, MESSAGES.passwordTooLong],
  ])(
    '%s: the field error shows, the alert says to fix the fields and takes focus, and no request is made',
    async (_n, over, message) => {
      const f = fakeFetch({})
      render(<InvitePage />)
      const user = userEvent.setup()
      const values = { name: 'Ann', email: 'ann@x.test', password: PASSWORD, ...over }
      for (const [label, v] of [
        ['Name', values.name],
        ['Email', values.email],
        ['Password', values.password],
      ] as const)
        if (v.trim()) await user.type(screen.getByLabelText(label), v)
      await submit(user)
      expect(await screen.findByText(message)).toBeTruthy()
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toBe(MESSAGES.fixFields)
      expect(document.activeElement).toBe(alert)
      expect(f.calls).toEqual([])
    },
  )

  it('all fields empty: required errors on each, no request', async () => {
    const f = fakeFetch({})
    render(<InvitePage />)
    await submit(userEvent.setup())
    expect(await screen.findByText(MESSAGES.nameRequired)).toBeTruthy()
    expect(screen.getByText(MESSAGES.emailRequired)).toBeTruthy()
    expect(f.calls).toEqual([])
  })

  it('a 128-character and an 8-character password are accepted', async () => {
    for (const password of ['x'.repeat(128), 'x'.repeat(8)]) {
      cleanup()
      history.replaceState(null, '', `/invite#token=${TOKEN}`)
      const f = fakeFetch({ 'POST /auth/sign-up/email': { status: 200, json: { user: { email: 'ann@x.test' } } } })
      const go = vi.fn()
      render(<InvitePage navigate={go} />)
      await submit(await fill({ password }))
      await waitFor(() => expect(go).toHaveBeenCalled())
      expect(f.calls).toHaveLength(1)
    }
  })
})

describe('the request', () => {
  it('is POST /auth/sign-up/email with exactly { name, email, password, invitation_token }', async () => {
    const f = fakeFetch({ 'POST /auth/sign-up/email': { status: 200, json: { user: { email: 'ann@x.test' } } } })
    render(<InvitePage navigate={() => {}} />)
    await submit(await fill())
    await waitFor(() => expect(f.calls).toHaveLength(1))
    expect(f.calls[0]!.body).toEqual({
      name: 'Ann Tester',
      email: 'ann@x.test',
      password: PASSWORD,
      invitation_token: TOKEN,
    })
  })

  it('success navigates to /home', async () => {
    fakeFetch({ 'POST /auth/sign-up/email': { status: 200, json: { user: { email: 'ann@x.test' } } } })
    const go = vi.fn()
    render(<InvitePage navigate={go} />)
    await submit(await fill())
    await waitFor(() => expect(go).toHaveBeenCalledWith('/home'))
  })

  it('the submit button is busy while the request is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    fakeFetch({
      'POST /auth/sign-up/email': async () => (await gate, { status: 200, json: { user: { email: 'ann@x.test' } } }),
    })
    render(<InvitePage navigate={() => {}} />)
    await submit(await fill())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /create account/i }).getAttribute('aria-busy')).toBe('true'),
    )
    release()
  })
})

describe('refusals', () => {
  const cases: Array<[string, { status: number; json?: unknown; text?: string }, string]> = [
    [
      '403 invitation_required',
      {
        status: 403,
        json: { code: 'invitation_required', message: 'sign-up requires a valid invitation for this email' },
      },
      MESSAGES.invitationRefused,
    ],
    [
      'invitation_acceptance_failed',
      { status: 500, json: { code: 'invitation_acceptance_failed', message: 'the account could not be settled' } },
      MESSAGES.inviteAccountExists,
    ],
    ['429', { status: 429, json: { message: 'Too many requests. Please try again later.' } }, MESSAGES.rateLimited],
    ['an unknown status', { status: 418, json: { code: 'TEAPOT' } }, genericFailure(418)],
    ['an unknown code on a 403', { status: 403, json: { code: 'SOMETHING_ELSE' } }, genericFailure(403)],
    ['a non-JSON 500', { status: 500, text: '<html>boom</html>' }, genericFailure(500)],
  ]
  it.each(cases)(
    '%s reaches its message in an alert that takes focus, and the form stays',
    async (_n, reply, message) => {
      fakeFetch({ 'POST /auth/sign-up/email': reply })
      const go = vi.fn()
      render(<InvitePage navigate={go} />)
      await submit(await fill())
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe(message)
      await waitFor(() => expect(document.activeElement).toBe(alert))
      expect(go).not.toHaveBeenCalled()
      expect(screen.getByLabelText('Email')).toBeTruthy()
    },
  )

  it('a network failure reads as the connection message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    render(<InvitePage navigate={() => {}} />)
    await submit(await fill())
    expect((await screen.findByRole('alert')).textContent).toBe(genericFailure(0))
  })

  it('a second failure with the same message focuses the alert again', async () => {
    fakeFetch({ 'POST /auth/sign-up/email': { status: 403, json: { code: 'invitation_required' } } })
    render(<InvitePage navigate={() => {}} />)
    const user = await fill()
    await submit(user)
    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(document.activeElement).toBe(alert))
    ;(screen.getByLabelText('Name') as HTMLInputElement).focus()
    await submit(user)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')))
  })

  it("a server message is never rendered: markup in `message` shows the page's own text and creates no element", async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><b id="injected">server says hi</b>'
    fakeFetch({ 'POST /auth/sign-up/email': { status: 403, json: { code: 'invitation_required', message: hostile } } })
    render(<InvitePage navigate={() => {}} />)
    await submit(await fill())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(MESSAGES.invitationRefused)
    expect(document.getElementById('injected')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect(document.body.textContent).not.toContain('server says hi')
  })
})

// #376: top to bottom: h1, Google (when discovery lists it), an OR divider hidden from assistive tech, the "Create a new account" form, the full-width submit, then the sign-in text link.
describe('the layout (#376)', () => {
  const DISCOVERY = {
    'GET /.well-known/vibase': {
      status: 200,
      json: { auth: { provider: 'better-auth', sign_in_methods: ['password', 'google'] } },
    },
  }
  it('orders header, Google, OR, form heading, fields, submit, link; one h1; the divider is aria-hidden', async () => {
    fakeFetch(DISCOVERY)
    render(<InvitePage />)
    const google = await screen.findByRole('button', { name: MESSAGES.googleButton })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Accept your invitation')
    const divider = screen.getByText('OR')
    expect(divider.closest('[aria-hidden="true"]')).toBeTruthy()
    const sub = screen.getByRole('heading', { name: 'Create a new account' })
    const name = screen.getByLabelText('Name')
    const submit = screen.getByRole('button', { name: /^create account$/i })
    const link = screen.getByRole('button', { name: /already have an account\? sign in to accept/i })
    const h1 = screen.getByRole('heading', { level: 1 })
    const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    const order = [h1, google, divider, sub, name, submit, link]
    for (let i = 0; i < order.length - 1; i++) expect(follows(order[i]!, order[i + 1]!)).toBe(true)
    // Layout intent (was `vb-link`, not `vb-button`): text styled as a link, not a filled button, and never the form's submit.
    expect(link.getAttribute('type')).toBe('button')
    expect(link.className).toContain('underline-offset-4')
    expect(link.className).not.toContain('bg-primary')
    expect(link.className).not.toContain('bg-secondary')
  })

  it('without Google in discovery there is no OR divider', async () => {
    fakeFetch({
      'GET /.well-known/vibase': {
        status: 200,
        json: { auth: { provider: 'better-auth', sign_in_methods: ['password'] } },
      },
    })
    render(<InvitePage />)
    await screen.findByLabelText('Email')
    expect(screen.queryByText('OR')).toBeNull()
  })

  it('the submit button sits in the card body (a stretched column), not the shrink-to-fit actions row', () => {
    render(<InvitePage />)
    const submit = screen.getByRole('button', { name: /^create account$/i })
    // Layout intent (was `.vb-card__actions` / `.vb-card__body` / `vb-button--block`): inside the content slot, not the footer slot, full width.
    expect(submit.closest('[data-slot="card-footer"]')).toBeNull()
    expect(submit.closest('[data-slot="card-content"]')).toBeTruthy()
    expect(submit.className.split(' ')).toContain('w-full')
  })
})

// [[CORE302]] P6: the sign-in mode, for a person whose account already exists (a removed member invited again): the token rides `/auth/sign-in/email` as the `vibase-invitation` header (the sign-in body schema strips it).
describe('the sign-in mode (CORE302 P6)', () => {
  const MODE = /already have an account\? sign in to accept/i
  const switchToSignIn = async () => {
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: MODE }))
    return user
  }
  const signInFields = async (
    user: ReturnType<typeof userEvent.setup>,
    o: { email?: string; password?: string } = {},
  ) => {
    await user.type(screen.getByLabelText('Email'), o.email ?? 'ann@x.test')
    await user.type(screen.getByLabelText('Password'), o.password ?? PASSWORD)
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))
  }

  it('the switch shows email and password only (no name), a Sign in button and a way back; the sign-up mode is the default', async () => {
    fakeFetch({})
    render(<InvitePage />)
    expect(screen.getByLabelText('Name')).toBeTruthy()
    await switchToSignIn()
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password')
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: /create (an )?account/i }))
    expect(screen.getByLabelText('Name')).toBeTruthy()
  })

  it('posts /auth/sign-in/email with { email, password } and the token in the vibase-invitation header; success navigates to /home', async () => {
    const f = fakeFetch({ 'POST /auth/sign-in/email': { status: 200, json: { user: { email: 'ann@x.test' } } } })
    const go = vi.fn()
    render(<InvitePage navigate={go} />)
    await signInFields(await switchToSignIn())
    await waitFor(() => expect(go).toHaveBeenCalledWith('/home'))
    expect(f.requests()).toEqual(['POST /auth/sign-in/email'])
    expect(f.calls[0]!.body).toEqual({ email: 'ann@x.test', password: PASSWORD })
    expect(new Headers(f.calls[0]!.init.headers as HeadersInit).get('vibase-invitation')).toBe(TOKEN)
  })

  it.each([
    ['bad credentials (401)', { status: 401, json: { code: 'INVALID_EMAIL_OR_PASSWORD' } }, MESSAGES.wrongCredentials],
    ['429', { status: 429, json: { message: 'Too many requests.' } }, MESSAGES.rateLimited],
    [
      'invitation_acceptance_failed',
      { status: 500, json: { code: 'invitation_acceptance_failed' } },
      MESSAGES.signInAcceptanceFailed,
    ],
  ])('%s shows the existing message in an alert and it clears on the next submit', async (_n, reply, message) => {
    let first = true
    fakeFetch({
      'POST /auth/sign-in/email': () =>
        first ? ((first = false), reply) : { status: 200, json: { user: { email: 'ann@x.test' } } },
    })
    const go = vi.fn()
    render(<InvitePage navigate={go} />)
    const user = await switchToSignIn()
    await signInFields(user)
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(go).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))
    await waitFor(() => expect(go).toHaveBeenCalledWith('/home'))
    expect(screen.queryByText(message)).toBeNull()
  })

  it('client validation sends nothing: an empty password and a bad email', async () => {
    const f = fakeFetch({})
    render(<InvitePage />)
    const user = await switchToSignIn()
    await user.type(screen.getByLabelText('Email'), 'ann@')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))
    expect(await screen.findByText(MESSAGES.emailInvalid)).toBeTruthy()
    expect(screen.getByText(MESSAGES.passwordRequired)).toBeTruthy()
    expect(f.calls).toEqual([])
  })
})
