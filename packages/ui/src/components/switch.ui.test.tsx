// [[UI449]] cycle 1 group 3 (D7): the Switch behaves as a switch: role, state, keyboard, disabled, accessible name, axe, no inline style.
import axe from 'axe-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, userEvent } from '#render'
import { Label } from './ui/label'
import { Switch } from './ui/switch'

function Labelled(props: {
  checked?: boolean
  disabled?: boolean
  onCheckedChange?: (v: boolean) => void
  label?: boolean
}) {
  const { label = true, ...rest } = props
  return (
    <div>
      <Switch id="s" {...rest} />
      {label ? <Label htmlFor="s">Read</Label> : null}
    </div>
  )
}

function Parent() {
  const [on, setOn] = useState(true)
  return <Labelled checked={on} onCheckedChange={setOn} />
}

describe('Switch', () => {
  it('is role=switch with aria-checked following the state, off by default', async () => {
    render(<Labelled />)
    const sw = screen.getByRole('switch', { name: 'Read' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await userEvent.setup().click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await userEvent.setup().click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('click and Space toggle it and report through onCheckedChange', async () => {
    const onCheckedChange = vi.fn()
    render(<Labelled onCheckedChange={onCheckedChange} />)
    const user = userEvent.setup()
    const sw = screen.getByRole('switch', { name: 'Read' })
    await user.click(sw)
    expect(onCheckedChange).toHaveBeenLastCalledWith(true)
    await user.tab() // leaves the switch
    await user.tab({ shift: true }) // back onto it
    expect(document.activeElement).toBe(sw)
    await user.keyboard(' ')
    expect(onCheckedChange).toHaveBeenLastCalledWith(false)
    expect(onCheckedChange).toHaveBeenCalledTimes(2)
  })

  it('a controlled checked wins over a click', async () => {
    const onCheckedChange = vi.fn()
    render(<Labelled checked onCheckedChange={onCheckedChange} />)
    const sw = screen.getByRole('switch', { name: 'Read' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await userEvent.setup().click(sw)
    expect(onCheckedChange).toHaveBeenCalledWith(false)
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('a controlled switch follows its parent', async () => {
    render(<Parent />)
    const sw = screen.getByRole('switch', { name: 'Read' })
    await userEvent.setup().click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('disabled neither toggles nor reports, on or off', async () => {
    const onCheckedChange = vi.fn()
    const { unmount } = render(<Labelled disabled onCheckedChange={onCheckedChange} />)
    const off = screen.getByRole('switch', { name: 'Read' }) as HTMLButtonElement
    expect(off.disabled).toBe(true)
    await userEvent.setup().click(off)
    expect(off.getAttribute('aria-checked')).toBe('false')
    unmount()
    render(<Labelled disabled checked onCheckedChange={onCheckedChange} />)
    const on = screen.getByRole('switch', { name: 'Read' })
    await userEvent.setup().click(on)
    expect(on.getAttribute('aria-checked')).toBe('true')
    expect(onCheckedChange).not.toHaveBeenCalled()
  })

  it('the accessible name comes from the associated Label, and clicking the label toggles', async () => {
    render(<Labelled />)
    const sw = screen.getByRole('switch', { name: 'Read' })
    await userEvent.setup().click(screen.getByText('Read'))
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('without a Label it has no accessible name (the mutation the name test catches)', () => {
    render(<Labelled label={false} />)
    expect(screen.queryByRole('switch', { name: 'Read' })).toBeNull()
  })

  it('has axe zero violations, in every state', async () => {
    render(
      <main>
        <h1>x</h1>
        <Labelled />
        <div>
          <Switch id="a" checked onCheckedChange={() => {}} />
          <Label htmlFor="a">On</Label>
        </div>
        <div>
          <Switch id="b" disabled />
          <Label htmlFor="b">Disabled off</Label>
        </div>
        <div>
          <Switch id="c" disabled checked />
          <Label htmlFor="c">Disabled on</Label>
        </div>
        <form>
          <Switch id="d" name="d" />
          <Label htmlFor="d">In a form</Label>
        </form>
      </main>,
    )
    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
  })

  it('carries a focus ring and a visibly different on state, in classes', () => {
    render(
      <>
        <Switch id="x" aria-label="x" />
        <Switch id="y" aria-label="y" checked onCheckedChange={() => {}} />
      </>,
    )
    const [x, y] = [screen.getByLabelText('x'), screen.getByLabelText('y')]
    expect(x.className).toContain('focus-visible:ring-2')
    expect(x.className).not.toMatch(/(^|\s)outline-none(\s|$)/)
    expect(x.className).toContain('data-[state=checked]:bg-primary')
    expect(y.getAttribute('data-state')).toBe('checked')
    expect(x.getAttribute('data-state')).toBe('unchecked')
  })

  it('the source has no style prop and no <style> element (UI445 D6)', () => {
    const src = readFileSync(join(import.meta.dirname, 'ui/switch.tsx'), 'utf8')
    expect(src).not.toMatch(/\bstyle\s*=/)
    expect(src).not.toMatch(/<style\b/)
  })
})
