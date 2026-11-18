// @vitest-environment happy-dom
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccountsPage } from './accounts.js'

// [[UI468]] groups 1 (rendering) and 5 (D8, D9, P5, P6): the row actions, Disconnect and Sync now over a fake Api.
const ME = 'user-me'
const CID = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'
const RW = ['connections:read', 'connections:write']
afterEach(() => {
  cleanup()
  history.replaceState(null, '', '/accounts')
})
beforeEach(() => history.replaceState(null, '', '/accounts'))

type Res<T> = { status: number; body: T | null; code?: string; message?: string }
const ok = <T,>(body: T): Res<T> => ({ status: 200, body })
const conn = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  owner_id: ME,
  identity_id: `i-${id}`,
  status: 'active',
  capture_labels: ['INBOX'],
  blocked_senders: [],
  exclude_group_addresses: false,
  exclude_personal_domains: false,
  contact_creation: 'sent',
  last_synced_at: null,
  last_error_code: null,
  ...over,
})
const fakeApi = (
  over: {
    connections?: () => Promise<Res<unknown[]>>
    syncConnection?: (id: string) => Promise<Res<unknown>>
    deleteConnection?: (id: string) => Promise<Res<unknown>>
    connection?: (id: string) => Promise<Res<unknown>>
  } = {},
) => ({
  connections: vi.fn(over.connections ?? (async () => ok([conn('amy'), conn('bob', { owner_id: 'other' })]))),
  identityAddress: vi.fn(async (id: string) => ok(`${id.slice(2)}@x.test`)),
  authorizeGmail: vi.fn(),
  syncConnection: vi.fn(over.syncConnection ?? (async () => ({ status: 202, body: { requested_at: 't' } }))),
  deleteConnection: vi.fn(over.deleteConnection ?? (async () => ({ status: 204, body: null }))),
  connection: vi.fn(over.connection ?? (async () => ok(conn(CID, { identity_id: 'i-cid' })))),
  updateConnection: vi.fn(),
})
const show = (api: ReturnType<typeof fakeApi>, scopes: string[] = RW, navigate = vi.fn()) => {
  render(<AccountsPage api={api as never} userId={ME} scopes={scopes} navigate={navigate} />)
  return navigate
}
const rowOf = (address: string) => screen.getByText(address).closest('li') as HTMLElement
const noViolations = async () => {
  const results = await axe.run(
    { include: [document.body], exclude: [['[data-aria-hidden]']] },
    { rules: { 'color-contrast': { enabled: false } } },
  )
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
}
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('row actions render by the matrix (group 1: P4)', () => {
  it("a writer: own active row has Settings (a link), Sync now, Disconnect; another member's active row has the same", async () => {
    show(fakeApi())
    await screen.findByText('amy@x.test')
    for (const address of ['amy@x.test', 'bob@x.test']) {
      const row = within(rowOf(address))
      expect(row.getByRole('link', { name: `Settings: ${address}` }).getAttribute('href')).toBe(
        address === 'amy@x.test' ? '/accounts?connection=amy' : '/accounts?connection=bob',
      )
      expect(row.getByRole('button', { name: `Sync now: ${address}` })).toBeTruthy()
      expect(row.getByRole('button', { name: `Disconnect: ${address}` })).toBeTruthy()
      expect(row.queryByRole('button', { name: /^Reconnect/ })).toBeNull()
    }
  })

  it("a non-active row has no Sync now; an own one has Reconnect, another member's has none", async () => {
    show(
      fakeApi({
        connections: async () =>
          ok([conn('amy', { status: 'reauth_required' }), conn('bob', { owner_id: 'o', status: 'suspended' })]),
      }),
    )
    await screen.findByText('amy@x.test')
    expect(screen.queryByRole('button', { name: /^Sync now/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Reconnect/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Disconnect: bob@x.test' })).toBeTruthy()
  })

  it('a reader gets Settings only', async () => {
    show(fakeApi(), ['connections:read'])
    await screen.findByText('amy@x.test')
    expect(screen.getAllByRole('link', { name: /^Settings: / })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^(Sync now|Disconnect|Reconnect)/ })).toBeNull()
  })
})

describe('Disconnect (group 5: D8, P6)', () => {
  const open = async (address = 'amy@x.test') => {
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: `Disconnect: ${address}` }))
    return user
  }

  it("opens the dialog with D8's texts and focus on Cancel; the extra line only on another member's mailbox", async () => {
    show(fakeApi())
    await screen.findByText('amy@x.test')
    await open()
    const dialog = await screen.findByRole('alertdialog', { name: 'Disconnect amy@x.test?' })
    expect(dialog.textContent).toContain(
      'Vibase stops reading this mailbox and forgets its sign-in. Mail already captured stays in the CRM. You can connect it again later.',
    )
    expect(dialog.textContent).not.toContain("This is another member's mailbox.")
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog).getByRole('button', { name: 'Disconnect' })).toBeTruthy()
    await noViolations()
    await userEvent.setup().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await open('bob@x.test')
    expect((await screen.findByRole('alertdialog')).textContent).toContain("This is another member's mailbox.")
  })

  it('Cancel makes no call', async () => {
    const api = fakeApi()
    show(api)
    await screen.findByText('amy@x.test')
    const user = await open()
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.deleteConnection).not.toHaveBeenCalled()
  })

  it('confirm: 204 closes it, reads the list again and shows "Disconnected <address>." politely', async () => {
    let reads = 0
    const api = fakeApi({
      connections: async () => {
        reads++
        return ok(reads === 1 ? [conn('amy'), conn('bob', { owner_id: 'o' })] : [conn('bob', { owner_id: 'o' })])
      },
    })
    show(api)
    await screen.findByText('amy@x.test')
    const user = await open()
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    const note = await screen.findByText('Disconnected amy@x.test.')
    expect(note.closest('[role="status"]')).toBeTruthy()
    expect(api.deleteConnection).toHaveBeenCalledExactlyOnceWith('amy')
    expect(api.connections).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByText('amy@x.test')).toBeNull()
  })

  it('a 404 on delete is the same as success', async () => {
    const api = fakeApi({ deleteConnection: async () => ({ status: 404, body: null, code: 'not_found' }) })
    show(api)
    await screen.findByText('amy@x.test')
    const user = await open()
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByText('Disconnected amy@x.test.')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('another failure keeps the dialog open with the error', async () => {
    const api = fakeApi({ deleteConnection: async () => ({ status: 500, body: null, code: 'internal' }) })
    show(api)
    await screen.findByText('amy@x.test')
    const user = await open()
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/Could not disconnect/)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.queryByText('Disconnected amy@x.test.')).toBeNull()
  })

  it('from the settings view a 204 navigates to /accounts and nothing is carried', async () => {
    history.replaceState(null, '', `/accounts?connection=${CID}`)
    const api = fakeApi()
    const navigate = show(api)
    await screen.findByRole('heading', { level: 1, name: 'cid@x.test' })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Disconnect cid@x.test?' })
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith('/accounts'))
    expect(api.deleteConnection).toHaveBeenCalledExactlyOnceWith(CID)
  })
})

describe('Sync now (group 5: D9, P5)', () => {
  const click = async (address = 'amy@x.test') => {
    await userEvent.setup().click(screen.getByRole('button', { name: `Sync now: ${address}` }))
  }
  const statusOf = (address: string) =>
    within(rowOf(address))
      .queryAllByRole('status')
      .map((s) => s.textContent)
      .join(' ')

  it('202 shows "Sync requested. New mail appears shortly." on that row only, in a polite status', async () => {
    const api = fakeApi()
    show(api)
    await screen.findByText('amy@x.test')
    await click()
    await waitFor(() => expect(statusOf('amy@x.test')).toContain('Sync requested. New mail appears shortly.'))
    expect(statusOf('bob@x.test')).not.toContain('Sync requested')
    expect(screen.getAllByText('Sync requested. New mail appears shortly.')).toHaveLength(1)
    expect(api.syncConnection).toHaveBeenCalledExactlyOnceWith('amy')
    expect(api.connections).toHaveBeenCalledTimes(1)
  })

  it.each([
    [409, 'connection_inactive'],
    [404, 'not_found'],
  ])('%s %s reads the list again', async (status, code) => {
    const api = fakeApi({ syncConnection: async () => ({ status, body: null, code }) })
    show(api)
    await screen.findByText('amy@x.test')
    await click()
    await waitFor(() => expect(api.connections).toHaveBeenCalledTimes(2))
    await screen.findByText('amy@x.test')
  })

  it("503 shows the server's message on the row", async () => {
    const api = fakeApi({
      syncConnection: async () => ({
        status: 503,
        body: null,
        code: 'sync_unavailable',
        message: 'the sync request was recorded but the run could not be started',
      }),
    })
    show(api)
    await screen.findByText('amy@x.test')
    await click()
    await waitFor(() =>
      expect(statusOf('amy@x.test')).toContain('the sync request was recorded but the run could not be started'),
    )
  })

  it('501 says this instance cannot sync, on that row', async () => {
    const api = fakeApi({ syncConnection: async () => ({ status: 501, body: null, code: 'provider_not_configured' }) })
    show(api)
    await screen.findByText('amy@x.test')
    await click()
    await waitFor(() => expect(statusOf('amy@x.test')).toContain('This instance cannot sync mailboxes'))
    expect(statusOf('bob@x.test')).not.toContain('cannot sync')
  })

  it('a second click while the request runs sends no second call', async () => {
    const d = deferred<Res<unknown>>()
    const api = fakeApi({ syncConnection: () => d.promise })
    show(api)
    await screen.findByText('amy@x.test')
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: 'Sync now: amy@x.test' })
    await user.click(button)
    await user.click(button)
    expect(api.syncConnection).toHaveBeenCalledTimes(1)
    d.resolve({ status: 202, body: { requested_at: 't' } })
    await waitFor(() => expect(statusOf('amy@x.test')).toContain('Sync requested'))
  })

  it('axe: the populated list with actions and an outcome', async () => {
    show(fakeApi())
    await screen.findByText('amy@x.test')
    await click()
    await waitFor(() => expect(statusOf('amy@x.test')).toContain('Sync requested'))
    await noViolations()
  })
})
