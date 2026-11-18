// [[UI448]] group 1: the Button composite's accessibility contract on real React ([[UI254]] D6): variants, `type`, busy.
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

  it('disabled disables without aria-busy; an enabled button fires onClick from the keyboard', async () => {
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

  it('each variant renders a different look, and block fills the width', () => {
    render(
      <>
        <Button variant="primary">P</Button>
        <Button variant="secondary">S</Button>
        <Button variant="destructive">D</Button>
        <Button variant="link">L</Button>
        <Button block>B</Button>
      </>,
    )
    const classes = ['P', 'S', 'D', 'L'].map((n) => screen.getByRole('button', { name: n }).className)
    expect(new Set(classes).size).toBe(4)
    expect(screen.getByRole('button', { name: 'B' }).className).toContain('w-full')
    expect(screen.getByRole('button', { name: 'P' }).className).not.toContain('w-full')
  })

  it('keeps a focus ring: focus-visible ring classes and no outline-none', () => {
    render(<Button>Ring</Button>)
    const cls = screen.getByRole('button', { name: 'Ring' }).className
    expect(cls).toContain('focus-visible:ring-2')
    expect(cls).not.toMatch(/(^|\s)outline-none(\s|$)/)
  })
})
