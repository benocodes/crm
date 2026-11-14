import { describe, expect, it, vi } from 'vitest'
import { render, screen, userEvent } from '#render'
import { Button } from './button'

describe('Button', () => {
  it('is a native button with type="button" by default', () => {
    render(<Button>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.hasAttribute('aria-busy')).toBe(false)
  })

  it('is type="submit" only when asked', () => {
    render(<Button type="submit">Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('type')).toBe('submit')
  })

  it('busy sets aria-busy and disables it, and a click does nothing', async () => {
    const onClick = vi.fn()
    render(
      <Button busy onClick={onClick}>
        Wait
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Wait' }) as HTMLButtonElement
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.disabled).toBe(true)
    await userEvent.setup().click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('disabled disables without aria-busy; an enabled click and the keyboard both fire onClick', async () => {
    const onClick = vi.fn()
    const { unmount } = render(<Button disabled>Off</Button>)
    const off = screen.getByRole('button', { name: 'Off' }) as HTMLButtonElement
    expect(off.disabled).toBe(true)
    expect(off.hasAttribute('aria-busy')).toBe(false)
    unmount()
    render(<Button onClick={onClick}>On</Button>)
    const user = userEvent.setup()
    await user.tab()
    await user.keyboard('{Enter}')
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('carries its variant as a vb- class', () => {
    render(<Button variant="destructive">Delete</Button>)
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('vb-button--destructive')
  })
})
