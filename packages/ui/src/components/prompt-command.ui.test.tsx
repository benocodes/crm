// [[UI443]] cycle 1, group 4 (D11): prompts act and commands copy safely.
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, userEvent, waitFor } from '#render'
import { CommandBlock } from './command-block'
import { PromptCard } from './prompt-card'

const stubClipboard = (writeText: (t: string) => Promise<void>) => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}
afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('PromptCard', () => {
  it('a link action carries its href, with the title, text and body', () => {
    render(
      <PromptCard title="Connect your email" text="Add your mailbox." action={{ label: 'Connect', href: '/accounts' }}>
        <p>Body here</p>
      </PromptCard>,
    )
    expect(screen.getByRole('heading', { name: 'Connect your email' })).toBeTruthy()
    expect(screen.getByText('Add your mailbox.')).toBeTruthy()
    expect(screen.getByText('Body here')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Connect' }).getAttribute('href')).toBe('/accounts')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a button action reports its click', async () => {
    const onClick = vi.fn()
    render(<PromptCard title="T" text="x" action={{ label: 'Go', onClick }} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('has axe zero violations', async () => {
    render(
      <main>
        <h1>Home</h1>
        <PromptCard title="T" text="x" action={{ label: 'Go', href: '/a' }}>
          <p>b</p>
        </PromptCard>
      </main>,
    )
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(r.violations.map((v) => v.id)).toEqual([])
  })
})

const ATTACK = '<b>x</b> & "q"'

describe('CommandBlock', () => {
  it('renders a command with markup characters as literal text, never elements', () => {
    const { container } = render(<CommandBlock command={ATTACK} />)
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe(ATTACK)
  })

  it('Copy writes exactly the command and announces Copied in a polite live region', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    render(<CommandBlock command={ATTACK} />)
    const live = screen.getByRole('status')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(ATTACK)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'))
  })

  it('a rejected write announces the failure; the next successful copy replaces it', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(<CommandBlock command="echo hi" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Could not copy. Select the text and copy it yourself.'),
    )
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'))
  })

  it('no Clipboard at all is a failure too', async () => {
    render(<CommandBlock command="echo hi" />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Could not copy/))
  })

  it('Copied clears after 3 seconds; a failure stays until the next attempt', async () => {
    stubClipboard(vi.fn(async () => {}))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<CommandBlock command="echo hi" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'))
    await vi.advanceTimersByTimeAsync(2900)
    expect(screen.getByRole('status').textContent).toBe('Copied')
    await vi.advanceTimersByTimeAsync(200)
    expect(screen.getByRole('status').textContent).toBe('')
    stubClipboard(vi.fn().mockRejectedValue(new Error('x')))
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Could not copy/))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(screen.getByRole('status').textContent).toMatch(/^Could not copy/)
  })

  it('the optional label names the button', () => {
    render(<CommandBlock command="x" label="the install command" />)
    expect(screen.getByRole('button', { name: 'Copy the install command' })).toBeTruthy()
  })

  it('has axe zero violations before and after Copy', async () => {
    stubClipboard(vi.fn(async () => {}))
    render(
      <main>
        <h1>Home</h1>
        <CommandBlock command={ATTACK} />
      </main>,
    )
    const run = () => axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect((await run()).violations.map((v) => v.id)).toEqual([])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'))
    expect((await run()).violations.map((v) => v.id)).toEqual([])
  })
})
