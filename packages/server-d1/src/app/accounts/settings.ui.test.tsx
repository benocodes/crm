// @vitest-environment happy-dom
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccountsPage } from './accounts.js'

// [[UI468]] groups 2 and 4 (D6, D7, D12, P3, P4): the settings view at /accounts?connection=<id> over a fake Api.
const CID = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'
const ME = 'user-me'
const RW = ['connections:read', 'connections:write']
afterEach(() => {
  cleanup()
  history.replaceState(null, '', '/app/accounts')
})
beforeEach(() => history.replaceState(null, '', `/app/accounts?connection=${CID}`))

type Res<T> = { status: number; body: T | null; code?: string; message?: string }
const ok = <T,>(body: T): Res<T> => ({ status: 200, body })
const rec = (over: Record<string, unknown> = {}) => ({
  id: CID,
  owner_id: ME,
  identity_id: 'i-1',
  status: 'active',
  capture_labels: ['INBOX', 'Label_1'],
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
    connection?: (id: string) => Promise<Res<unknown>>
    identityAddress?: (id: string) => Promise<Res<string>>
    updateConnection?: (id: string, body: unknown) => Promise<Res<unknown>>
    deleteConnection?: (id: string) => Promise<Res<unknown>>
  } = {},
) => ({
  connection: vi.fn(over.connection ?? (async () => ok(rec()))),
  identityAddress: vi.fn(over.identityAddress ?? (async () => ok('mailbox@e2e.test'))),
  updateConnection: vi.fn(over.updateConnection ?? (async () => ok(rec()))),
  deleteConnection: vi.fn(over.deleteConnection ?? (async () => ({ status: 204, body: null }))),
  syncConnection: vi.fn(async () => ({ status: 202, body: { requested_at: 't' } })),
  connections: vi.fn(async () => ok([])),
  authorizeGmail: vi.fn(),
})
const show = (api: ReturnType<typeof fakeApi>, scopes: string[] = RW, navigate = vi.fn()) => {
  render(<AccountsPage api={api as never} userId={ME} scopes={scopes} navigate={navigate} />)
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
const heading = () => screen.findByRole('heading', { level: 1, name: 'mailbox@e2e.test' })
const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement

describe('the settings view and its access (group 2: D6, D12, P4)', () => {
  it('shows Loading… while reading, then the address as the title, the back link, the status and the form for the owner', async () => {
    const d = deferred<Res<unknown>>()
    show(fakeApi({ connection: () => d.promise }))
    expect(screen.getByText('Loading…')).toBeTruthy()
    d.resolve(ok(rec()))
    await heading()
    expect(screen.getByRole('link', { name: 'Back to Connected accounts' }).getAttribute('href')).toBe('/app/accounts')
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Inbox' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Sent' }).getAttribute('aria-checked')).toBe('false')
    expect(within(screen.getByRole('list', { name: 'Other labels' })).getByText('Label_1')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'People I send mail to' })).toHaveProperty('checked', true)
    expect(save().disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sync now/ })).toBeNull()
  })

  it('reads connections.get once with the id and the address with identities.get; document.title names both', async () => {
    const api = fakeApi()
    show(api)
    await heading()
    expect(api.connection).toHaveBeenCalledExactlyOnceWith(CID)
    expect(api.identityAddress).toHaveBeenCalledExactlyOnceWith('i-1')
    expect(api.connections).not.toHaveBeenCalled()
    await waitFor(() => expect(document.title).toBe('mailbox@e2e.test · Connected accounts · Vibase'))
  })

  it('the address falls back to "Gmail account" when its read fails', async () => {
    show(fakeApi({ identityAddress: async () => ({ status: 403, body: null }) }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Gmail account' })).toBeTruthy()
  })

  it("a member sees another's mailbox read-only: the line, a <dl>, no inputs, no Save, no switches", async () => {
    show(fakeApi({ connection: async () => ok(rec({ owner_id: 'someone-else' })) }))
    await heading()
    expect(screen.getByText('Only the person who connected this mailbox can change its settings.')).toBeTruthy()
    expect(document.querySelectorAll('dl').length).toBeGreaterThan(0)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByText('Label_1', { exact: false })).toBeTruthy()
    // Disconnect stays for a writer (D8).
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
  })

  it('the owner without connections:write is read-only too (editing needs ownership AND write)', async () => {
    show(fakeApi(), ['connections:read'])
    await heading()
    expect(screen.getByText('Only the person who connected this mailbox can change its settings.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
  })

  it('a 404 says "This mailbox is not connected." with the back link', async () => {
    show(fakeApi({ connection: async () => ({ status: 404, body: null, code: 'not_found' }) }))
    expect(await screen.findByText('This mailbox is not connected.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to Connected accounts' }).getAttribute('href')).toBe('/app/accounts')
  })

  it('a malformed id says the same and makes no connections.get call', async () => {
    history.replaceState(null, '', '/app/accounts?connection=not-a-uuid')
    const api = fakeApi()
    show(api)
    expect(await screen.findByText('This mailbox is not connected.')).toBeTruthy()
    expect(api.connection).not.toHaveBeenCalled()
    expect(api.identityAddress).not.toHaveBeenCalled()
  })

  it('a failed read is the page error, and Retry reads again', async () => {
    let n = 0
    const api = fakeApi({ connection: async () => (n++ === 0 ? { status: 500, body: null } : ok(rec())) })
    show(api)
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be read/)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    await heading()
    expect(api.connection).toHaveBeenCalledTimes(2)
  })

  it('without connections:read: the no-access text and not one connections or identities call', async () => {
    const api = fakeApi()
    show(api, ['connections:write'])
    expect(await screen.findByText("You don't have access to connected accounts.")).toBeTruthy()
    await new Promise((r) => setTimeout(r, 20))
    expect(api.connection).not.toHaveBeenCalled()
    expect(api.connections).not.toHaveBeenCalled()
    expect(api.identityAddress).not.toHaveBeenCalled()
  })

  it('axe: zero violations on the form, the read-only view and not-connected, each with the h1 above', async () => {
    show(fakeApi())
    await heading()
    await noViolations()
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    cleanup()
    show(fakeApi({ connection: async () => ok(rec({ owner_id: 'o' })) }))
    await heading()
    await noViolations()
    cleanup()
    show(fakeApi({ connection: async () => ({ status: 404, body: null }) }))
    await screen.findByText('This mailbox is not connected.')
    await noViolations()
    expect(document.querySelectorAll('h1')).toHaveLength(1)
  })
})

describe('Save outcomes (group 4: D7)', () => {
  const addBlocked = async (user: ReturnType<typeof userEvent.setup>, value: string) => {
    await user.type(screen.getByLabelText('Blocked addresses and domains'), value)
    await user.click(screen.getByRole('button', { name: 'Add blocked sender' }))
  }

  it('Save is enabled by an edit and sends connections.update with exactly the changed fields', async () => {
    const api = fakeApi()
    show(api)
    await heading()
    const user = userEvent.setup()
    await addBlocked(user, 'Spam@Example.com')
    await user.click(screen.getByRole('radio', { name: 'Nobody' }))
    expect(save().disabled).toBe(false)
    await user.click(save())
    await waitFor(() => expect(api.updateConnection).toHaveBeenCalledTimes(1))
    expect(api.updateConnection).toHaveBeenCalledWith(CID, {
      blocked_senders: [{ kind: 'address', value: 'Spam@Example.com' }],
      contact_creation: 'none',
    })
  })

  it('200 replaces the values from the RETURNED record (a normalised blocked value) and says "Saved." politely', async () => {
    const api = fakeApi({
      updateConnection: async () =>
        ok(rec({ blocked_senders: [{ kind: 'address', value: 'spam@example.com' }], contact_creation: 'none' })),
    })
    show(api)
    await heading()
    const user = userEvent.setup()
    await addBlocked(user, 'Spam@Example.com')
    await user.click(screen.getByRole('radio', { name: 'Nobody' }))
    await user.click(save())
    const status = await screen.findByText('Saved.')
    expect(status.closest('[role="status"]')).toBeTruthy()
    expect(
      within(screen.getByRole('list', { name: 'Blocked addresses and domains' })).getByText('spam@example.com'),
    ).toBeTruthy()
    expect(screen.queryByText('Spam@Example.com')).toBeNull()
    expect(save().disabled).toBe(true)
  })

  it('400 shows the server message in the error alert and keeps the edits', async () => {
    const api = fakeApi({
      updateConnection: async () => ({
        status: 400,
        body: null,
        code: 'validation_error',
        message: 'blocked_senders[0]: invalid email address',
      }),
    })
    show(api)
    await heading()
    const user = userEvent.setup()
    await addBlocked(user, 'bad@')
    await user.click(save())
    expect((await screen.findByRole('alert')).textContent).toContain('blocked_senders[0]: invalid email address')
    expect(within(screen.getByRole('list', { name: 'Blocked addresses and domains' })).getByText('bad@')).toBeTruthy()
    expect(save().disabled).toBe(false)
  })

  it('no labels at all: "Choose at least one label." and no call', async () => {
    const api = fakeApi()
    show(api)
    await heading()
    const user = userEvent.setup()
    await user.click(screen.getByRole('switch', { name: 'Inbox' }))
    await user.click(screen.getByRole('button', { name: 'Remove Label_1' }))
    await user.click(save())
    expect((await screen.findByRole('alert')).textContent).toContain('Choose at least one label.')
    expect(api.updateConnection).not.toHaveBeenCalled()
  })

  it.each([
    [403, 'not_connection_owner'],
    [404, 'not_found'],
  ])('%s %s reads the view again', async (status, code) => {
    let reads = 0
    const api = fakeApi({
      connection: async () => {
        reads++
        return reads === 1 ? ok(rec()) : { status: 404, body: null }
      },
      updateConnection: async () => ({ status, body: null, code }),
    })
    show(api)
    await heading()
    const user = userEvent.setup()
    await user.click(screen.getByRole('switch', { name: 'Sent' }))
    await user.click(save())
    expect(await screen.findByText('This mailbox is not connected.')).toBeTruthy()
    expect(api.connection).toHaveBeenCalledTimes(2)
  })

  it('a second click while saving sends no second call', async () => {
    const d = deferred<Res<unknown>>()
    const api = fakeApi({ updateConnection: () => d.promise })
    show(api)
    await heading()
    const user = userEvent.setup()
    await user.click(screen.getByRole('switch', { name: 'Sent' }))
    await user.click(save())
    await user.click(save())
    expect(api.updateConnection).toHaveBeenCalledTimes(1)
    d.resolve(ok(rec({ capture_labels: ['INBOX', 'SENT', 'Label_1'] })))
    await screen.findByText('Saved.')
  })
})
