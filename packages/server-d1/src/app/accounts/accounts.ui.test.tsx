// @vitest-environment happy-dom
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createApi } from '../session/api.js'
import { AccountsPage } from './accounts.js'

// [[UI467]] groups 2, 3, 4 (D2, D3, D4, D12): the page over a fake Api; the real client over a fake fetch for "every page".
afterEach(() => {
  cleanup()
  history.replaceState(null, '', '/accounts')
})
beforeEach(() => history.replaceState(null, '', '/accounts'))

const NOW = new Date('2026-11-18T12:00:00.000Z')
const ME = 'user-me'
const RW = ['connections:read', 'connections:write']
const conn = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  owner_id: ME,
  identity_id: `i-${id}`,
  status: 'active',
  last_synced_at: null,
  last_error_code: null,
  ...over,
})
type Res<T> = { status: number; body: T | null; code?: string }
const ok = <T,>(body: T): Res<T> => ({ status: 200, body })
const fakeApi = (
  over: {
    connections?: () => Promise<Res<unknown[]>>
    identityAddress?: (id: string) => Promise<Res<string>>
    authorizeGmail?: () => Promise<Res<{ authorize_url: string; expires_at: string }>>
  } = {},
) => ({
  connections: vi.fn(over.connections ?? (async () => ok([]))),
  identityAddress: vi.fn(over.identityAddress ?? (async (id: string) => ok(`${id.slice(2)}@x.test`))),
  authorizeGmail: vi.fn(
    over.authorizeGmail ?? (async () => ok({ authorize_url: 'https://accounts.google.test/consent', expires_at: 't' })),
  ),
})
const show = (api: ReturnType<typeof fakeApi>, scopes: string[] = RW, navigate = vi.fn()) => {
  render(<AccountsPage api={api as never} userId={ME} scopes={scopes} now={() => NOW} navigate={navigate} />)
  return navigate
}
const noViolations = async () => {
  const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
}
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('lists and states (group 4: D2, D12)', () => {
  it('shows Loading… until the list answers, then the two sections with rows ordered by address', async () => {
    const d = deferred<Res<unknown[]>>()
    show(fakeApi({ connections: () => d.promise }))
    expect(screen.getByRole('heading', { level: 1, name: 'Connected accounts' })).toBeTruthy()
    expect(screen.getByText('Loading…')).toBeTruthy()
    d.resolve(ok([conn('zed'), conn('amy'), conn('bob', { owner_id: 'someone' })]))
    const yours = await screen.findByRole('region', { name: 'Your mailboxes' })
    expect(
      within(yours)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining('amy@x.test'), expect.stringContaining('zed@x.test')])
    const others = screen.getByRole('region', { name: 'Other mailboxes' })
    expect(within(others).getByText('bob@x.test')).toBeTruthy()
    expect(within(others).getByText("Another member's mailbox")).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('Other mailboxes is absent when nobody else owns one', async () => {
    show(fakeApi({ connections: async () => ok([conn('amy')]) }))
    await screen.findByRole('region', { name: 'Your mailboxes' })
    expect(screen.queryByRole('region', { name: 'Other mailboxes' })).toBeNull()
  })

  it('reads every page of the list: the real client over a two-page fake fetch', async () => {
    const pages = [
      { data: [conn('amy')], next_cursor: 'c1' },
      { data: [conn('bob')], next_cursor: null },
    ]
    const urls: string[] = []
    const api = createApi({
      origin: 'https://w.test',
      getToken: async () => 't',
      fetch: (async (url: string) => {
        urls.push(String(url))
        if (String(url).includes('/connections')) return new Response(JSON.stringify(pages.shift()))
        const id = String(url).split('/').pop()!
        return new Response(JSON.stringify({ id, value: `${id.slice(2)}@x.test` }))
      }) as unknown as typeof fetch,
    })
    render(<AccountsPage api={api} userId={ME} scopes={RW} now={() => NOW} navigate={() => {}} />)
    await screen.findByText('amy@x.test')
    expect(screen.getByText('bob@x.test')).toBeTruthy()
    expect(urls.filter((u) => u.includes('/connections'))).toHaveLength(2)
  })

  it('a failed list is the page error; Retry reads it again and recovers', async () => {
    let n = 0
    const api = fakeApi({
      connections: async () => (++n === 1 ? { status: 500, body: null } : ok([conn('amy')])),
    })
    show(api)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('The mailboxes could not be read. Try again.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('amy@x.test')
    expect(api.connections).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a thrown list read is the same page error', async () => {
    show(
      fakeApi({
        connections: async () => {
          throw new Error('network')
        },
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toBe('The mailboxes could not be read. Try again.')
  })

  it('one failed identities.get leaves the other rows and the list intact; a refused one too', async () => {
    const api = fakeApi({
      connections: async () => ok([conn('amy'), conn('bob'), conn('cat'), conn('dan', { owner_id: 'o' })]),
      identityAddress: async (id) =>
        id === 'i-bob'
          ? { status: 500, body: null }
          : id === 'i-dan'
            ? { status: 403, body: null }
            : id === 'i-cat'
              ? (() => {
                  throw new Error('network')
                })()
              : ok('amy@x.test'),
    })
    show(api)
    await screen.findByText('amy@x.test')
    expect(screen.getAllByText('Gmail account')).toHaveLength(3)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.identityAddress).toHaveBeenCalledTimes(4)
  })

  it('without connections:read: the no-access text, and not one list or identity read', async () => {
    const api = fakeApi({ connections: async () => ok([conn('amy')]) })
    show(api, ['connections:write'])
    expect(await screen.findByText("You don't have access to connected accounts.")).toBeTruthy()
    await new Promise((r) => setTimeout(r, 20))
    expect(api.connections).not.toHaveBeenCalled()
    expect(api.identityAddress).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Connect Gmail/ })).toBeNull()
  })

  it('read-only: rows show, but no Connect Gmail and no Reconnect', async () => {
    show(fakeApi({ connections: async () => ok([conn('amy', { status: 'reauth_required' })]) }), ['connections:read'])
    await screen.findByText('amy@x.test')
    expect(screen.queryByRole('button', { name: /Connect Gmail|Reconnect/ })).toBeNull()
    expect(screen.getByText('Needs reconnect')).toBeTruthy()
  })

  it('empty Your mailboxes says "No mailbox connected yet" with Connect Gmail for a writer (two buttons: the page actions and the empty state), and none for a reader', async () => {
    show(fakeApi())
    await screen.findByText('No mailbox connected yet')
    expect(screen.getAllByRole('button', { name: 'Connect Gmail' })).toHaveLength(2)
    cleanup()
    show(fakeApi(), ['connections:read'])
    await screen.findByText('No mailbox connected yet')
    expect(screen.queryByRole('button', { name: 'Connect Gmail' })).toBeNull()
  })

  it('axe: zero violations populated, empty and failed, each with the h1 above', async () => {
    show(fakeApi({ connections: async () => ok([conn('amy'), conn('bob', { owner_id: 'o', status: 'suspended' })]) }))
    await screen.findByText('amy@x.test')
    await noViolations()
    cleanup()
    show(fakeApi())
    await screen.findByText('No mailbox connected yet')
    await noViolations()
    cleanup()
    show(fakeApi({ connections: async () => ({ status: 500, body: null }) }))
    await screen.findByRole('alert')
    await noViolations()
    expect(document.querySelectorAll('h1')).toHaveLength(1)
  })
})

describe('Connect Gmail and Reconnect (group 3: D3)', () => {
  it('calls connections.authorize once, busy and disabled while waiting, then navigates to authorize_url', async () => {
    const d = deferred<Res<{ authorize_url: string; expires_at: string }>>()
    const api = fakeApi({ authorizeGmail: () => d.promise })
    const navigate = show(api)
    await screen.findByText('No mailbox connected yet')
    const [first, second] = screen.getAllByRole('button', { name: 'Connect Gmail' })
    const user = userEvent.setup()
    await user.click(first!)
    expect(api.authorizeGmail).toHaveBeenCalledTimes(1)
    expect((first as HTMLButtonElement).disabled).toBe(true)
    expect((second as HTMLButtonElement).disabled).toBe(true)
    expect(first!.getAttribute('aria-busy')).toBe('true')
    await user.click(second!)
    await user.click(first!)
    expect(api.authorizeGmail).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
    d.resolve(ok({ authorize_url: 'https://accounts.google.test/consent?x=1', expires_at: 't' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith('https://accounts.google.test/consent?x=1'))
  })

  it('501 provider_not_configured shows the instance sentence, does not navigate, and the button is usable again', async () => {
    const api = fakeApi({
      authorizeGmail: async () => ({ status: 501, body: null, code: 'provider_not_configured' }),
    })
    const navigate = show(api)
    await screen.findByText('No mailbox connected yet')
    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: 'Connect Gmail' })[0]!)
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Gmail is not set up on this instance. The instance's operator sets it up (see the setup guide).",
    )
    expect(navigate).not.toHaveBeenCalled()
    expect((screen.getAllByRole('button', { name: 'Connect Gmail' })[0] as HTMLButtonElement).disabled).toBe(false)
  })

  it('another failure says "Could not start connecting. Try again." with the code; a thrown call too; the button is usable again', async () => {
    let n = 0
    const api = fakeApi({
      authorizeGmail: async () => {
        if (++n === 2) throw new Error('network')
        return { status: 403, body: null, code: 'user_required' }
      },
    })
    const navigate = show(api)
    await screen.findByText('No mailbox connected yet')
    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: 'Connect Gmail' })[0]!)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not start connecting. Try again. (user_required)',
    )
    await user.click(screen.getAllByRole('button', { name: 'Connect Gmail' })[0]!)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not start connecting. Try again.'))
    expect(api.authorizeGmail).toHaveBeenCalledTimes(2)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('a failure with no code falls back to the status', async () => {
    show(fakeApi({ authorizeGmail: async () => ({ status: 502, body: null }) }))
    await screen.findByText('No mailbox connected yet')
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Connect Gmail' })[0]!)
    expect((await screen.findByRole('alert')).textContent).toBe('Could not start connecting. Try again. (502)')
  })

  it('Reconnect runs the same flow from its row, once, and only on own non-active rows', async () => {
    const api = fakeApi({
      connections: async () =>
        ok([
          conn('amy', { status: 'reauth_required' }),
          conn('bob'),
          conn('cat', { owner_id: 'o', status: 'suspended' }),
        ]),
    })
    const navigate = show(api)
    await screen.findByText('amy@x.test')
    expect(screen.getAllByRole('button', { name: /^Reconnect/ })).toHaveLength(1)
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: 'Reconnect: amy@x.test' })
    await user.click(button)
    await user.click(button)
    expect(api.authorizeGmail).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith('https://accounts.google.test/consent'))
  })

  it('Reconnect failing shows the page alert too', async () => {
    const api = fakeApi({
      connections: async () => ok([conn('amy', { status: 'reauth_required' })]),
      authorizeGmail: async () => ({ status: 501, body: null, code: 'provider_not_configured' }),
    })
    show(api)
    await screen.findByText('amy@x.test')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reconnect: amy@x.test' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Gmail is not set up on this instance/)
  })
})

describe('the connect return (group 2: D4)', () => {
  it('reads connection_id, removes it with replaceState (other parameters kept, no navigation), and names the listed address', async () => {
    history.replaceState(null, '', '/accounts?connection_id=c-amy&x=1')
    const replace = vi.spyOn(history, 'replaceState')
    const assign = vi.fn()
    const api = fakeApi({ connections: async () => ok([conn('c-amy', { identity_id: 'i-amy' })]) })
    render(<AccountsPage api={api as never} userId={ME} scopes={RW} now={() => NOW} navigate={assign} />)
    expect(location.pathname + location.search).toBe('/accounts?x=1')
    expect(replace).toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe('Connected amy@x.test.')
    replace.mockRestore()
  })

  it('an id that is not listed reads "Mailbox connected."', async () => {
    history.replaceState(null, '', '/accounts?connection_id=00000000-0000-4000-8000-000000000000')
    show(fakeApi({ connections: async () => ok([conn('c-amy')]) }))
    expect((await screen.findByRole('status')).textContent).toBe('Mailbox connected.')
  })

  it('an error code shows the callback sentence and the code; the URL loses it', async () => {
    history.replaceState(null, '', '/accounts?error=consent_denied&x=1')
    show(fakeApi())
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The connection was cancelled at Google. Nothing was connected. (consent_denied)',
    )
    expect(location.search).toBe('?x=1')
  })

  it('an unknown code reads "The mailbox was not connected." and the code', async () => {
    history.replaceState(null, '', '/accounts?error=brand_new')
    show(fakeApi())
    expect((await screen.findByRole('alert')).textContent).toBe('The mailbox was not connected. (brand_new)')
  })

  it('a reload (a fresh mount on the cleaned URL) shows no outcome', async () => {
    history.replaceState(null, '', '/accounts?error=consent_denied&x=1')
    show(fakeApi())
    await screen.findByRole('alert')
    cleanup()
    show(fakeApi())
    await screen.findByText('No mailbox connected yet')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
