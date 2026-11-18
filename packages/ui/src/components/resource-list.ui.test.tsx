// [[UI458]] cycle 1, group 1 (D11): ResourceList and StatusBadge are a list a screen reader can act on.
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, userEvent } from '#render'
import { ResourceList, type ResourceListItem } from './resource-list'
import { StatusBadge } from './status-badge'

const noViolations = async () => {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
}

const items = (onSync: (id: string) => void = () => {}): ResourceListItem[] => [
  {
    id: 'a',
    title: 'ada@example.com',
    meta: ['Gmail', 'Synced today'],
    status: <StatusBadge tone="success">Active</StatusBadge>,
    actions: [
      { label: 'Sync now', onClick: () => onSync('a') },
      { label: 'Open', href: '/accounts?connection=a' },
    ],
  },
  {
    id: 'b',
    title: 'bob@example.com',
    status: <StatusBadge tone="danger">Needs reconnecting</StatusBadge>,
    actions: [{ label: 'Sync now', onClick: () => onSync('b') }],
  },
]

describe('ResourceList', () => {
  it('renders rows as li in a named ul with title, meta lines and status', () => {
    render(
      <>
        <h1>Page</h1>
        <ResourceList label="Mailboxes" items={items()} emptyText="None" />
      </>,
    )
    const list = screen.getByRole('list', { name: 'Mailboxes' })
    expect(list.tagName).toBe('UL')
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.tagName === 'LI')).toBe(true)
    expect(rows[0]?.textContent).toContain('ada@example.com')
    expect(rows[0]?.textContent).toContain('Gmail')
    expect(rows[0]?.textContent).toContain('Synced today')
    expect(rows[0]?.textContent).toContain('Active')
    expect(rows[1]?.textContent).toContain('Needs reconnecting')
  })

  it('a button action reports its click for that row; a link action carries its href', async () => {
    const onSync = vi.fn()
    render(<ResourceList label="Mailboxes" items={items(onSync)} emptyText="None" />)
    await userEvent.click(screen.getByRole('button', { name: /Sync now.*bob@example.com/ }))
    expect(onSync).toHaveBeenCalledTimes(1)
    expect(onSync).toHaveBeenCalledWith('b')
    const link = screen.getByRole('link', { name: /Open.*ada@example.com/ })
    expect(link.getAttribute('href')).toBe('/accounts?connection=a')
  })

  it('every action name includes the row title, so two rows with the same label are distinguishable', () => {
    render(<ResourceList label="Mailboxes" items={items()} emptyText="None" />)
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    for (const name of names) expect(name).toMatch(/^Sync now/)
    expect(names[0]).toContain('ada@example.com')
    expect(names[1]).toContain('bob@example.com')
    expect(screen.getByRole('link').getAttribute('aria-label')).toContain('ada@example.com')
  })

  it('empty renders its text and optional action and no list', () => {
    render(
      <ResourceList
        label="Mailboxes"
        items={[]}
        emptyText="No mailboxes yet."
        emptyAction={<button type="button">Connect</button>}
      />,
    )
    expect(screen.getByText('No mailboxes yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('loading sets aria-busy="true" and clears it after', () => {
    const { container, rerender } = render(
      <ResourceList label="Mailboxes" items={[]} emptyText="None" loading loadingText="Loading mailboxes" />,
    )
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.getByText('Loading mailboxes')).toBeTruthy()
    expect(screen.queryByText('None')).toBeNull()
    rerender(<ResourceList label="Mailboxes" items={items()} emptyText="None" />)
    expect(container.querySelector('[aria-busy]')).toBeNull()
  })

  it('has axe zero violations: rows, empty, loading', async () => {
    const { rerender } = render(
      <>
        <h1>Page</h1>
        <ResourceList label="Mailboxes" items={items()} emptyText="None" />
      </>,
    )
    await noViolations()
    rerender(
      <>
        <h1>Page</h1>
        <ResourceList
          label="Mailboxes"
          items={[]}
          emptyText="None"
          emptyAction={<button type="button">Connect</button>}
        />
      </>,
    )
    await noViolations()
    rerender(
      <>
        <h1>Page</h1>
        <ResourceList label="Mailboxes" items={[]} emptyText="None" loading loadingText="Loading" />
      </>,
    )
    await noViolations()
  })
})

describe('StatusBadge', () => {
  it.each(['neutral', 'success', 'warning', 'danger'] as const)('%s renders its text and names its tone', (tone) => {
    const { container } = render(<StatusBadge tone={tone}>Label {tone}</StatusBadge>)
    expect(screen.getByText(`Label ${tone}`)).toBeTruthy()
    expect(container.querySelector(`[data-tone="${tone}"]`)).not.toBeNull()
  })

  it('defaults to neutral and carries its meaning in text, not colour alone', () => {
    const { container } = render(<StatusBadge>Paused</StatusBadge>)
    expect(container.querySelector('[data-tone="neutral"]')?.textContent).toBe('Paused')
  })

  it('has axe zero violations in every tone', async () => {
    render(
      <>
        <h1>Page</h1>
        {(['neutral', 'success', 'warning', 'danger'] as const).map((t) => (
          <StatusBadge key={t} tone={t}>
            {t}
          </StatusBadge>
        ))}
      </>,
    )
    await noViolations()
  })
})
