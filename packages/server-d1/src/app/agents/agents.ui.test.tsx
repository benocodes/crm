// @vitest-environment happy-dom
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentsPage } from './agents.js'
import { FORM_MANAGED_LINE, grantCommand } from './view-model.js'

// [[UI459]] groups 4 and 5 (D1, D2, D3, D5, D6, D8, P5): the page over a fake Api.
afterEach(cleanup)
const ME = 'user-me'
const RO = ['agents:read']
const RW = ['agents:read', 'agents:write']
type Res<T> = { status: number; body: T | null; code?: string; message?: string }
const ok = <T,>(body: T): Res<T> => ({ status: 200, body })
const rec = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  scopes: ['contacts:read'],
  disabled_at: null,
  created_at: '2026-11-01T10:00:00.000Z',
  auth_subject: null,
  auth_client_id: null,
  delegated_by: null,
  ...over,
})
const DEFAULT = () => [rec('alpha'), rec('Beta', { disabled_at: '2026-11-05T00:00:00.000Z' })]
const fakeApi = (
  over: {
    agents?: () => Promise<Res<unknown[]>>
    forms?: () => Promise<Res<unknown[]>>
    setDisabled?: (id: string, disabled: boolean) => Promise<Res<unknown>>
  } = {},
) => ({
  agents: vi.fn(over.agents ?? (async () => ok(DEFAULT()))),
  forms: vi.fn(over.forms ?? (async () => ok([]))),
  setDisabled: vi.fn(
    over.setDisabled ?? (async (id: string, disabled: boolean) => ok(rec(id, { disabled_at: disabled ? '2026-11-19T00:00:00.000Z' : null }))),
  ),
})
const show = (api: ReturnType<typeof fakeApi>, scopes: string[] = RW) =>
  render(
    <AgentsPage
      api={api as never}
      userId={ME}
      scopes={scopes}
      instructions={{ origin: 'https://w.test', signIn: true, mcpUrl: null }}
      formatDate={(iso: string) => iso.slice(0, 10)}
    />,
  )
const rowOf = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li') as HTMLElement
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

describe('page states (group 4)', () => {
  it('loading, then the list and then the instructions, in that order, under one Agents heading', async () => {
    const d = deferred<Res<unknown[]>>()
    const api = fakeApi({ agents: () => d.promise })
    show(api)
    expect(screen.getByText('Loading…')).toBeTruthy()
    d.resolve(ok(DEFAULT()))
    await screen.findByText('alpha')
    expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy()
    expect(screen.getByText('Agents act in this CRM with the permissions an owner grants them.')).toBeTruthy()
    const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(h2).toEqual(['Connected agents', 'Connect an agent'])
    const list = screen.getByRole('list', { name: /agents/i })
    const login = screen.getByText('vibase login --server https://w.test')
    expect(list.compareDocumentPosition(login) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the two access notes
    expect(document.body.textContent).toContain('further bounded by what was approved on the consent screen')
    expect(document.body.textContent).toContain('Your own `vibase login` is you, not an agent')
  })

  it('rows are enabled first then by name, with the badge and the dates through the formatter', async () => {
    show(fakeApi())
    await screen.findByText('alpha')
    const names = within(screen.getByRole('list', { name: /agents/i }))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('span')?.textContent)
    expect(names).toEqual(['alpha', 'Beta'])
    expect(rowOf('alpha').textContent).toContain('Enabled')
    expect(rowOf('Beta').textContent).toContain('Disabled')
    expect(rowOf('Beta').textContent).toContain('Created 2026-11-01; disabled 2026-11-05')
    expect(rowOf('alpha').textContent).toContain('Permissions: contacts (read)')
  })

  it('empty list: the empty text, instructions still shown', async () => {
    show(fakeApi({ agents: async () => ok([]) }))
    await screen.findByText('No agents connected yet. Connect one with the instructions below.')
    expect(screen.getByText('vibase login --server https://w.test')).toBeTruthy()
  })

  it('a failed agents.list is the page error with Retry reading again; the instructions stay', async () => {
    let n = 0
    const api = fakeApi({ agents: async () => (n++ === 0 ? { status: 500, body: null } : ok(DEFAULT())) })
    show(api)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('The agents could not be read. Try again.')
    expect(screen.getByText('vibase login --server https://w.test')).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('alpha')
    expect(api.agents).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a thrown agents read is the same page error', async () => {
    show(
      fakeApi({
        agents: async () => {
          throw new Error('network')
        },
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toBe('The agents could not be read. Try again.')
  })

  it.each([
    ['a failed', async () => ({ status: 500, body: null })],
    ['a forbidden', async () => ({ status: 403, body: null, code: 'forbidden' })],
    [
      'a thrown',
      async () => {
        throw new Error('x')
      },
    ],
  ])('%s forms.list leaves the list shown, unmarked, and the page does not fail', async (_n, forms) => {
    const api = fakeApi({ forms: forms as never, agents: async () => ok([rec('f1', { scopes: [] })]) })
    show(api, [...RW, 'forms:read'])
    await screen.findByText('f1')
    expect(api.forms).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(rowOf('f1').textContent).not.toContain('Managed by its form')
    expect(rowOf('f1').textContent).toContain('API-key agent')
  })

  it('with forms:read a form agent is labelled by id and has no button and no grant command', async () => {
    const api = fakeApi({
      agents: async () => ok([rec('f1', { name: 'Contact us', scopes: [] }), rec('x')]),
      forms: async () => ok([{ id: 'f1', name: 'Website' }]),
    })
    show(api, [...RW, 'forms:read'])
    await screen.findByText('Contact us')
    const li = rowOf('Contact us')
    expect(li.textContent).toContain('Website form Website')
    expect(li.textContent).toContain(FORM_MANAGED_LINE)
    expect(within(li).queryByRole('button')).toBeNull()
    expect(li.textContent).not.toContain('vibase agents update')
    expect(within(rowOf('x')).getByRole('button', { name: 'Disable: x' })).toBeTruthy()
  })

  it('without forms:read no forms call is made', async () => {
    const api = fakeApi()
    show(api, RW)
    await screen.findByText('alpha')
    expect(api.forms).not.toHaveBeenCalled()
  })

  it('no agents:read: the no-access text, zero agents/forms calls, the instructions shown', async () => {
    const api = fakeApi()
    show(api, ['forms:read', 'agents:write'])
    expect(await screen.findByText("You don't have access to the agents list.")).toBeTruthy()
    expect(screen.getByText('vibase login --server https://w.test')).toBeTruthy()
    expect(screen.queryByRole('list', { name: /agents/i })).toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect(api.agents).not.toHaveBeenCalled()
    expect(api.forms).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy()
  })

  it('axe: list, empty, error and no-access states', async () => {
    show(fakeApi())
    await screen.findByText('alpha')
    await noViolations()
    cleanup()
    show(fakeApi({ agents: async () => ok([]) }))
    await screen.findByText(/No agents connected yet/)
    await noViolations()
    cleanup()
    show(fakeApi({ agents: async () => ({ status: 500, body: null }) }))
    await screen.findByRole('alert')
    await noViolations()
    cleanup()
    show(fakeApi(), [])
    await screen.findByText("You don't have access to the agents list.")
    await noViolations()
  })
})

describe('the grant command in the detail slot (group 2, in the view)', () => {
  const bare = () => ok([rec('bare', { scopes: [] })])
  it('an owner sees the line and the exact command for an agent with no scopes', async () => {
    show(fakeApi({ agents: async () => bare() }), RW)
    await screen.findByText('bare')
    const li = rowOf('bare')
    expect(li.textContent).toContain('No permissions yet')
    expect(li.textContent).toContain('It has no permissions yet. To grant some, run:')
    expect(li.querySelector('code')?.textContent).toBe(grantCommand('bare'))
  })
  it('a reader does not', async () => {
    show(fakeApi({ agents: async () => bare() }), RO)
    await screen.findByText('bare')
    expect(rowOf('bare').querySelector('code')).toBeNull()
    expect(rowOf('bare').textContent).not.toContain('To grant some')
    expect(within(rowOf('bare')).queryByRole('button')).toBeNull()
  })
})

describe('toggle outcomes (group 5: D5, D6, P5)', () => {
  const disable = async (name = 'alpha') => {
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: `Disable: ${name}` }))
    return user
  }
  it("Disable opens the dialog with D5's title and body, focus on Cancel; Cancel makes no call", async () => {
    const api = fakeApi()
    show(api)
    await screen.findByText('alpha')
    const user = await disable()
    const dialog = await screen.findByRole('alertdialog', { name: 'Disable alpha?' })
    expect(dialog.textContent).toContain(
      'alpha stops working at once: its API keys and sign-ins are refused until you enable it again. Nothing it did is undone.',
    )
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    await noViolations()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.setDisabled).not.toHaveBeenCalled()
  })

  it('confirm sends { disabled: true }; 200 replaces the row from the RETURNED record, re-sorts it below enabled rows and announces once', async () => {
    const api = fakeApi({
      agents: async () => ok([rec('alpha'), rec('zulu')]),
      // the returned record differs from what was sent: the row must show it
      setDisabled: async () => ok(rec('alpha', { scopes: ['tasks:read'], disabled_at: '2026-11-19T00:00:00.000Z' })),
    })
    show(api)
    await screen.findByText('alpha')
    const user = await disable()
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disable' }))
    await screen.findByText('Disabled alpha.')
    expect(api.setDisabled).toHaveBeenCalledExactlyOnceWith('alpha', true)
    expect(api.agents).toHaveBeenCalledTimes(1)
    const names = within(screen.getByRole('list', { name: /agents/i }))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('span')?.textContent)
    expect(names).toEqual(['zulu', 'alpha'])
    expect(rowOf('alpha').textContent).toContain('Permissions: tasks (read)')
    expect(rowOf('alpha').textContent).toContain('Disabled')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getAllByRole('status').filter((s) => s.textContent === 'Disabled alpha.')).toHaveLength(1)
    expect(within(rowOf('alpha')).getByRole('button', { name: 'Enable: alpha' })).toBeTruthy()
  })

  it('Enable acts at once with no dialog, sends { disabled: false } and announces', async () => {
    const api = fakeApi()
    show(api)
    await screen.findByText('Beta')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enable: Beta' }))
    await screen.findByText('Enabled Beta.')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.setDisabled).toHaveBeenCalledExactlyOnceWith('Beta', false)
    expect(rowOf('Beta').textContent).toContain('Enabled')
  })

  it('no announcement exists before a toggle', async () => {
    show(fakeApi())
    await screen.findByText('alpha')
    expect(screen.queryByText(/^(Disabled|Enabled) .*\.$/)).toBeNull()
  })

  it('404 reads the list again, and is not an error', async () => {
    let n = 0
    const api = fakeApi({
      agents: async () => ok(n++ === 0 ? DEFAULT() : [rec('Beta', { disabled_at: '2026-11-05T00:00:00.000Z' })]),
      setDisabled: async () => ({ status: 404, body: null, code: 'not_found' }),
    })
    show(api)
    await screen.findByText('alpha')
    const user = await disable()
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull())
    expect(api.agents).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('409 form_principal on Disable shows D6 sentence in the dialog, which stays open', async () => {
    const api = fakeApi({ setDisabled: async () => ({ status: 409, body: null, code: 'form_principal' }) })
    show(api)
    await screen.findByText('alpha')
    const user = await disable()
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Disable' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(FORM_MANAGED_LINE)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })

  it('another failure on Disable keeps the dialog open with the code; the list is unchanged', async () => {
    const api = fakeApi({ setDisabled: async () => ({ status: 500, body: null, code: 'internal' }) })
    show(api)
    await screen.findByText('alpha')
    const user = await disable()
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Disable' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('internal')
    expect(screen.queryByText('Disabled alpha.')).toBeNull()
    expect(api.agents).toHaveBeenCalledTimes(1)
  })

  it('a failure on Enable is a page Alert with the code, the list unchanged; the next toggle clears it', async () => {
    let fail = true
    const api = fakeApi({
      setDisabled: async (id, disabled) =>
        fail ? { status: 500, body: null, code: 'internal' } : ok(rec(id, { disabled_at: disabled ? 'x' : null })),
    })
    show(api)
    await screen.findByText('Beta')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Enable: Beta' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('internal')
    expect(rowOf('Beta').textContent).toContain('Disabled')
    fail = false
    await user.click(screen.getByRole('button', { name: 'Enable: Beta' }))
    await screen.findByText('Enabled Beta.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a 409 form_principal on Enable shows the sentence in a page Alert', async () => {
    const api = fakeApi({ setDisabled: async () => ({ status: 409, body: null, code: 'form_principal' }) })
    show(api)
    await screen.findByText('Beta')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enable: Beta' }))
    expect((await screen.findByRole('alert')).textContent).toBe(FORM_MANAGED_LINE)
  })

  it('a second click while busy sends no second call (Enable and confirm)', async () => {
    const d = deferred<Res<unknown>>()
    const api = fakeApi({ setDisabled: () => d.promise })
    show(api)
    await screen.findByText('Beta')
    const user = userEvent.setup()
    const enable = screen.getByRole('button', { name: 'Enable: Beta' })
    await user.click(enable)
    await user.click(enable)
    expect(api.setDisabled).toHaveBeenCalledTimes(1)
    d.resolve(ok(rec('Beta')))
    await screen.findByText('Enabled Beta.')
  })

  it('a thrown update on Enable is a page Alert', async () => {
    const api = fakeApi({
      setDisabled: async () => {
        throw new Error('x')
      },
    })
    show(api)
    await screen.findByText('Beta')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enable: Beta' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not enable Beta')
  })
})
