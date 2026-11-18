// [[UI458]] cycle 1, group 2 (D11, P3): ConfirmDialog confirms safely.
import axe from 'axe-core'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, userEvent, waitFor } from '#render'
import { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog'

// Radix hides what is behind a modal with `aria-hidden` and `data-aria-hidden` (the page's own content stays focusable but inert to the
// pointer, and its focus guards are tab stops): axe's aria-hidden-focus flags that by design, so the hidden siblings are excluded and
// everything else, the portalled dialog included, is checked on document.body.
const noViolations = async () => {
  const results = await axe.run(
    { include: [document.body], exclude: [['[data-aria-hidden]']] },
    { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } },
  )
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
}

type Extra = Partial<Omit<ConfirmDialogProps, 'open' | 'onOpenChange'>>
function Host(extra: Extra) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <h1>Page</h1>
      <button type="button" onClick={() => setOpen(true)}>
        Open it
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Disconnect ada@example.com?"
        description="Captured mail stays."
        cancelLabel="Keep"
        confirmLabel="Disconnect"
        onConfirm={() => {}}
        {...extra}
      />
    </>
  )
}
const openIt = async () => {
  const opener = screen.getByRole('button', { name: 'Open it' })
  await userEvent.click(opener)
  await screen.findByRole('alertdialog')
  return opener
}

describe('ConfirmDialog', () => {
  it('opens as an alertdialog named by the title, described by the description, focus on Cancel', async () => {
    render(<Host>{<p>Extra body</p>}</Host>)
    await openIt()
    const dialog = screen.getByRole('alertdialog', { name: 'Disconnect ada@example.com?' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(dialog.getAttribute('aria-describedby') as string)?.textContent).toBe(
      'Captured mail stays.',
    )
    expect(screen.getByText('Extra body')).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' })))
  })

  it('Cancel and Escape do not confirm, close, and return focus to the opener', async () => {
    const onConfirm = vi.fn()
    render(<Host onConfirm={onConfirm} />)
    let opener = await openIt()
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener = await openIt()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('an outside click does not close it', async () => {
    render(<Host />)
    await openIt()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(document.body)
    await user.click(screen.getByRole('heading', { name: 'Page', hidden: true }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })

  it('while the action runs both buttons are disabled and the dialog is busy; on success it closes', async () => {
    let finish: () => void = () => {}
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(<Host onConfirm={onConfirm} />)
    await openIt()
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(true),
    )
    expect((screen.getByRole('button', { name: 'Keep' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alertdialog').getAttribute('aria-busy')).toBe('true')
    finish()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('on failure it stays open with the error in an Alert inside it; the next attempt clears it; reopening clears it', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('Could not disconnect.'))
      .mockImplementationOnce(() => new Promise(() => {}))
    render(<Host onConfirm={onConfirm} />)
    await openIt()
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Could not disconnect.')
    expect(screen.getByRole('alertdialog').contains(alert)).toBe(true)
    expect((screen.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })

  it('a failed attempt is cleared when the dialog is reopened', async () => {
    render(<Host onConfirm={() => Promise.reject(new Error('Nope'))} />)
    await openIt()
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await openIt()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the error and busy props show those states', async () => {
    render(<Host error="Given error" busy />)
    await openIt()
    expect(screen.getByRole('alert').textContent).toBe('Given error')
    expect((screen.getByRole('button', { name: 'Keep' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('destructive gives Confirm the destructive variant; otherwise the primary one', async () => {
    const { unmount } = render(<Host destructive />)
    await openIt()
    expect(screen.getByRole('button', { name: 'Disconnect' }).className).toContain('bg-destructive')
    unmount()
    render(<Host />)
    await openIt()
    expect(screen.getByRole('button', { name: 'Disconnect' }).className).not.toContain('bg-destructive')
  })

  it('has axe zero violations while open (document.body), plain and with an error', async () => {
    const { unmount } = render(<Host destructive />)
    await openIt()
    await noViolations()
    unmount()
    render(<Host error="Boom" />)
    await openIt()
    await noViolations()
  })
})
