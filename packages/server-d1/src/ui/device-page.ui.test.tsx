// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SCOPE_DESCRIPTIONS } from '@vibase/api/scope-descriptions'
import { DevicePage } from './device-page.js'
import { fakeFetch } from './fake-fetch.js'
import { MESSAGES, genericFailure } from './messages.js'

// [[UI247]] D3: the device page. fetch is faked at the page boundary; every name, email and scope is asserted as text.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => history.replaceState(null, '', '/app/device'))

const NO_SESSION = { status: 200, json: null }
const SESSION = { status: 200, json: { user: { id: 'u1', email: 'ann@x.test', name: 'Ann' }, session: { id: 's1' } } }
const CLAIM = {
  status: 200,
  json: { user_code: 'ABCDEFGH', status: 'pending', client_id: 'vibase-cli', scope: 'openid contacts:read' },
}
const CLIENT = { status: 200, json: { client_id: 'vibase-cli', client_name: 'Vibase CLI' } }
const OK = { status: 200, json: { success: true } }
const urlsOf = (f: ReturnType<typeof fakeFetch>) => f.fn.mock.calls.map((c) => String(c[0]))
const happyRoutes = () => ({
  'GET /auth/get-session': SESSION,
  'GET /auth/device': CLAIM,
  'GET /auth/oauth2/public-client': CLIENT,
  'POST /auth/device/approve': OK,
  'POST /auth/device/deny': OK,
})
const submitCode = async (typed?: string) => {
  const user = userEvent.setup()
  if (typed !== undefined) await user.type(await screen.findByLabelText(MESSAGES.deviceCodeLabel), typed)
  await user.click(await screen.findByRole('button', { name: /check code/i }))
  return user
}

describe('no session', () => {
  it('goes to /sign-in?return_to= with this path and query, encoded, and shows no form', async () => {
    history.replaceState(null, '', '/app/device?user_code=abcd-efgh')
    fakeFetch({ 'GET /auth/get-session': NO_SESSION })
    const go = vi.fn()
    render(<DevicePage navigate={go} />)
    await waitFor(() =>
      expect(go).toHaveBeenCalledWith(
        `/app/sign-in?return_to=${encodeURIComponent('/app/device?user_code=abcd-efgh')}`,
      ),
    )
    expect(screen.queryByLabelText(MESSAGES.deviceCodeLabel)).toBeNull()
  })

  it('a failing session read is treated as no session', async () => {
    fakeFetch({ 'GET /auth/get-session': { status: 500, text: 'boom' } })
    const go = vi.fn()
    render(<DevicePage navigate={go} />)
    await waitFor(() => expect(go).toHaveBeenCalledWith('/app/sign-in?return_to=%2Fapp%2Fdevice'))
  })
})

describe('signed in: the code form', () => {
  it('shows "Signed in as <email>" and the code input prefilled from ?user_code= as XXXX-XXXX', async () => {
    history.replaceState(null, '', '/app/device?user_code=abcdefg')
    fakeFetch(happyRoutes())
    render(<DevicePage />)
    expect(await screen.findByText('Signed in as ann@x.test')).toBeTruthy()
    expect((screen.getByLabelText(MESSAGES.deviceCodeLabel) as HTMLInputElement).value).toBe('ABCD-EFG')
  })

  it('without ?user_code= the input is empty', async () => {
    fakeFetch(happyRoutes())
    render(<DevicePage />)
    expect(((await screen.findByLabelText(MESSAGES.deviceCodeLabel)) as HTMLInputElement).value).toBe('')
  })

  it('typing lower case, spaces and hyphens normalises to XXXX-XXXX and sends the unseparated code', async () => {
    const f = fakeFetch(happyRoutes())
    render(<DevicePage />)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(MESSAGES.deviceCodeLabel), 'ab cd-ef gh')
    expect((screen.getByLabelText(MESSAGES.deviceCodeLabel) as HTMLInputElement).value).toBe('ABCD-EFGH')
    await user.click(screen.getByRole('button', { name: /check code/i }))
    await screen.findByRole('button', { name: /approve/i })
    const claim = urlsOf(f).find((u) => u.startsWith('/auth/device?'))!
    expect(new URL(claim, 'http://x').searchParams.get('user_code')).toBe('ABCDEFGH')
  })

  it('an empty code sends nothing and says so', async () => {
    const f = fakeFetch(happyRoutes())
    render(<DevicePage />)
    await submitCode()
    expect(await screen.findByText(MESSAGES.deviceCodeRequired)).toBeTruthy()
    expect(f.requests()).toEqual(['GET /auth/get-session'])
  })

  it('"Use another account" signs out and goes to /sign-in?return_to= of this page', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    const f = fakeFetch({ ...happyRoutes(), 'POST /auth/sign-out': OK })
    const go = vi.fn()
    render(<DevicePage navigate={go} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: MESSAGES.useAnotherAccount }))
    await waitFor(() =>
      expect(go).toHaveBeenCalledWith(`/app/sign-in?return_to=${encodeURIComponent('/app/device?user_code=ABCDEFGH')}`),
    )
    expect(f.requests()).toContain('POST /auth/sign-out')
  })

  it('a failed sign-out shows an alert and goes nowhere', async () => {
    fakeFetch({ ...happyRoutes(), 'POST /auth/sign-out': { status: 500, text: 'boom' } })
    const go = vi.fn()
    render(<DevicePage navigate={go} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: MESSAGES.useAnotherAccount }))
    expect((await screen.findByRole('alert')).textContent).toBe(genericFailure(500))
    expect(go).not.toHaveBeenCalled()
  })
})

describe('claim, then review', () => {
  it('shows the app name, the code as XXXX-XXXX with the check line, the warning and the scopes with their sentences', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    const f = fakeFetch(happyRoutes())
    render(<DevicePage />)
    expect(await screen.findByText('Vibase CLI')).toBeTruthy()
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy()
    expect(screen.getByText(MESSAGES.deviceCheckCode)).toBeTruthy()
    expect(screen.getByText(MESSAGES.deviceWarning)).toBeTruthy()
    expect(screen.getByText('contacts:read')).toBeTruthy()
    expect(screen.getByText(SCOPE_DESCRIPTIONS['contacts:read']!)).toBeTruthy()
    expect(screen.getByText('openid')).toBeTruthy()
    expect(urlsOf(f).find((u) => u.startsWith('/auth/oauth2/public-client'))).toContain('client_id=vibase-cli')
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /deny/i })).toBeTruthy()
  })

  it('the client name, the email and a scope are text: markup creates no element', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    fakeFetch({
      ...happyRoutes(),
      'GET /auth/get-session': { status: 200, json: { user: { id: 'u', email: '<i id="e">a</i>@x.test' } } },
      'GET /auth/device': {
        status: 200,
        json: { user_code: 'ABCDEFGH', status: 'pending', client_id: 'c', scope: '<u>x</u>:read' },
      },
      'GET /auth/oauth2/public-client': { status: 200, json: { client_name: '<b id="n">Evil</b>' } },
    })
    render(<DevicePage />)
    await screen.findByText('<b id="n">Evil</b>')
    expect(screen.getByText('Signed in as <i id="e">a</i>@x.test')).toBeTruthy()
    expect(screen.getByText('<u>x</u>:read')).toBeTruthy()
    expect(document.querySelector('u')).toBeNull()
    for (const id of ['n', 'e']) expect(document.getElementById(id), id).toBeNull()
  })

  it('an unknown scope is shown by name with "No description"', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    fakeFetch({
      ...happyRoutes(),
      'GET /auth/device': {
        status: 200,
        json: { user_code: 'ABCDEFGH', status: 'pending', client_id: 'c', scope: 'mystery:read' },
      },
    })
    render(<DevicePage />)
    expect(await screen.findByText('mystery:read')).toBeTruthy()
    expect(screen.getByText(MESSAGES.noDescription)).toBeTruthy()
  })

  it('Approve posts { userCode } to /auth/device/approve and shows the return-to-terminal message', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    const f = fakeFetch(happyRoutes())
    render(<DevicePage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /approve/i }))
    expect(await screen.findByText(MESSAGES.deviceApproved)).toBeTruthy()
    expect(MESSAGES.deviceApproved).toContain('You can return to your terminal')
    expect(f.calls.find((c) => c.path === '/auth/device/approve')!.body).toEqual({ userCode: 'ABCDEFGH' })
    expect(f.requests()).not.toContain('POST /auth/device/deny')
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
  })

  it('Deny posts { userCode } to /auth/device/deny and shows the denied message', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    const f = fakeFetch(happyRoutes())
    render(<DevicePage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /deny/i }))
    expect(await screen.findByText(MESSAGES.deviceDenied)).toBeTruthy()
    expect(f.calls.find((c) => c.path === '/auth/device/deny')!.body).toEqual({ userCode: 'ABCDEFGH' })
    expect(f.requests()).not.toContain('POST /auth/device/approve')
  })
})

describe('one message per outcome', () => {
  const claimCases: Array<[string, { status: number; json?: unknown; text?: string }, string]> = [
    [
      'not recognised (400 invalid_request)',
      { status: 400, json: { error: 'invalid_request', error_description: 'Invalid user code' } },
      MESSAGES.deviceUnrecognised,
    ],
    [
      'an answer with no client_id (another account claimed it)',
      { status: 200, json: { user_code: 'ABCDEFGH', status: 'pending' } },
      MESSAGES.deviceUnrecognised,
    ],
    [
      'expired (400 expired_token)',
      { status: 400, json: { error: 'expired_token', error_description: 'User code has expired' } },
      MESSAGES.deviceExpired,
    ],
    [
      'already approved',
      { status: 200, json: { user_code: 'ABCDEFGH', status: 'approved', client_id: 'c', scope: 'openid' } },
      MESSAGES.deviceProcessed,
    ],
    [
      'already denied',
      { status: 200, json: { user_code: 'ABCDEFGH', status: 'denied', client_id: 'c', scope: 'openid' } },
      MESSAGES.deviceProcessed,
    ],
    ['too many attempts (429)', { status: 429, json: { message: 'Too many requests' } }, MESSAGES.rateLimited],
    ['a generic failure', { status: 503, text: 'down' }, genericFailure(503)],
  ]
  it.each(claimCases)('the claim: %s', async (_n, reply, message) => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    const f = fakeFetch({ ...happyRoutes(), 'GET /auth/device': reply })
    render(<DevicePage />)
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
    expect(f.requests()).not.toContain('GET /auth/oauth2/public-client')
    // the form, prefilled, Check code usable; and no retry after a re-render
    expect((screen.getByLabelText(MESSAGES.deviceCodeLabel) as HTMLInputElement).value).toBe('ABCD-EFGH')
    expect(screen.getByRole('button', { name: /check code/i })).toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
    expect(f.requests().filter((r) => r === 'GET /auth/device')).toHaveLength(1)
  })

  const decideCases: Array<[string, { status: number; json?: unknown; text?: string }, string]> = [
    ['expired', { status: 400, json: { error: 'expired_token' } }, MESSAGES.deviceExpired],
    [
      'already processed',
      { status: 400, json: { error: 'invalid_request', error_description: 'Device code already processed' } },
      MESSAGES.deviceProcessed,
    ],
    [
      'claimed by another account (403)',
      { status: 403, json: { error: 'access_denied' } },
      MESSAGES.deviceUnrecognised,
    ],
    ['429', { status: 429, json: {} }, MESSAGES.rateLimited],
    ['a generic failure', { status: 500, text: 'boom' }, genericFailure(500)],
  ]
  it.each(decideCases)('approve: %s', async (_n, reply, message) => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    fakeFetch({ ...happyRoutes(), 'POST /auth/device/approve': reply })
    render(<DevicePage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /approve/i }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
  })

  it('deny maps its failure the same way', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    fakeFetch({ ...happyRoutes(), 'POST /auth/device/deny': { status: 400, json: { error: 'expired_token' } } })
    render(<DevicePage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /deny/i }))
    expect((await screen.findByRole('alert')).textContent).toBe(MESSAGES.deviceExpired)
  })

  it('a server error_description or message is never shown', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    fakeFetch({
      ...happyRoutes(),
      'GET /auth/device': {
        status: 400,
        json: { error: 'invalid_request', error_description: '<b id="x">Invalid user code</b>', message: 'nope' },
      },
    })
    render(<DevicePage />)
    expect((await screen.findByRole('alert')).textContent).toBe(MESSAGES.deviceUnrecognised)
    expect(document.body.textContent).not.toContain('Invalid user code')
  })

  it('a failed app-name lookup falls back to the client id as text, and the review still shows', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    fakeFetch({ ...happyRoutes(), 'GET /auth/oauth2/public-client': { status: 404, json: { error: 'not_found' } } })
    render(<DevicePage />)
    expect(await screen.findByText('vibase-cli')).toBeTruthy()
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy()
  })
})

// [[UI381]] D9: the link is claimed on load, once, with no click.
describe('one step: a complete code in the link is claimed on load', () => {
  const claimsOf = (f: ReturnType<typeof fakeFetch>) => f.requests().filter((r) => r === 'GET /auth/device')

  it.each([
    ['separated', 'abcd-efgh'],
    ['unseparated', 'ABCDEFGH'],
  ])('%s: exactly one claim with that code, then the review, with no click', async (_n, link) => {
    history.replaceState(null, '', `/app/device?user_code=${link}`)
    const f = fakeFetch(happyRoutes())
    render(<DevicePage />)
    expect(await screen.findByText('Vibase CLI')).toBeTruthy()
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy()
    expect(screen.getByText(MESSAGES.deviceCheckCode)).toBeTruthy()
    expect(screen.getByText(MESSAGES.deviceWarning)).toBeTruthy()
    expect(claimsOf(f)).toHaveLength(1)
    const claim = urlsOf(f).find((u) => u.startsWith('/auth/device?'))!
    expect(new URL(claim, 'http://x').searchParams.get('user_code')).toBe('ABCDEFGH')
    expect(screen.queryByRole('button', { name: /check code/i })).toBeNull()
  })

  it('shows no Approve / Deny while the claim is pending', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    fakeFetch({
      ...happyRoutes(),
      'GET /auth/device': async () => {
        await gate
        return CLAIM
      },
    })
    render(<DevicePage />)
    await screen.findByText(MESSAGES.deviceChecking)
    expect(screen.queryByRole('button', { name: /approve|deny/i })).toBeNull()
    release()
    expect(await screen.findByRole('button', { name: /approve/i })).toBeTruthy()
  })

  it('approval still needs a click: nothing is posted until the button is pressed', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    const f = fakeFetch(happyRoutes())
    render(<DevicePage />)
    await screen.findByRole('button', { name: /approve/i })
    await new Promise((r) => setTimeout(r, 50))
    expect(f.requests()).not.toContain('POST /auth/device/approve')
    expect(f.requests()).not.toContain('POST /auth/device/deny')
    await userEvent.setup().click(screen.getByRole('button', { name: /approve/i }))
    expect(await screen.findByText(MESSAGES.deviceApproved)).toBeTruthy()
    expect(f.requests().filter((r) => r === 'POST /auth/device/approve')).toHaveLength(1)
  })
})

describe('where the page does not claim by itself', () => {
  const claimsOf = (f: ReturnType<typeof fakeFetch>) => f.requests().filter((r) => r === 'GET /auth/device')

  it.each([
    ['no user_code', '/app/device'],
    ['an incomplete code', '/app/device?user_code=ABCD'],
    ['a code too long', '/app/device?user_code=ABCDEFGHJ'],
    ['a code outside the alphabet (I, O, 0, 1)', '/app/device?user_code=ABCDEFG0'],
  ])('%s: the form, prefilled as typed, and no claim before a click', async (_n, url) => {
    history.replaceState(null, '', url)
    const f = fakeFetch(happyRoutes())
    render(<DevicePage />)
    await screen.findByRole('button', { name: /check code/i })
    await new Promise((r) => setTimeout(r, 50))
    expect(claimsOf(f)).toHaveLength(0)
  })

  it('an incomplete code is prefilled, and Check code on a typed completion still claims', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCD')
    const f = fakeFetch(happyRoutes())
    render(<DevicePage />)
    const user = userEvent.setup()
    expect(((await screen.findByLabelText(MESSAGES.deviceCodeLabel)) as HTMLInputElement).value).toBe('ABCD')
    await user.type(screen.getByLabelText(MESSAGES.deviceCodeLabel), 'efgh')
    await user.click(screen.getByRole('button', { name: /check code/i }))
    expect(await screen.findByRole('button', { name: /approve/i })).toBeTruthy()
    expect(claimsOf(f)).toHaveLength(1)
  })

  it('no session: the sign-in redirect and zero claim calls', async () => {
    history.replaceState(null, '', '/app/device?user_code=ABCDEFGH')
    const f = fakeFetch({ ...happyRoutes(), 'GET /auth/get-session': NO_SESSION })
    const go = vi.fn()
    render(<DevicePage navigate={go} />)
    await waitFor(() => expect(go).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 50))
    expect(claimsOf(f)).toHaveLength(0)
  })
})
