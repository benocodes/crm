// [[UI448]] group 1: the Input and Label primitives and their association.
import { describe, expect, it } from 'vitest'
import { render, screen, userEvent } from '#render'
import { Input, Label } from './ui'

describe('Input and Label primitives', () => {
  it('a Label names its Input by htmlFor', () => {
    render(
      <>
        <Label htmlFor="e">Email</Label>
        <Input id="e" type="email" />
      </>,
    )
    expect(screen.getByLabelText('Email').tagName).toBe('INPUT')
  })

  it('clicking the Label focuses the Input', async () => {
    render(
      <>
        <Label htmlFor="e">Email</Label>
        <Input id="e" />
      </>,
    )
    await userEvent.setup().click(screen.getByText('Email'))
    expect(document.activeElement).toBe(screen.getByLabelText('Email'))
  })

  it('an Input passes its attributes through and keeps a focus ring (no outline-none)', () => {
    render(<Input aria-label="x" type="email" autoComplete="email" name="e" />)
    const input = screen.getByLabelText('x')
    expect(input.getAttribute('type')).toBe('email')
    expect(input.getAttribute('autocomplete')).toBe('email')
    expect(input.className).toContain('focus-visible:ring-2')
    expect(input.className).not.toMatch(/(^|\s)outline-none(\s|$)/)
  })

  it('aria-invalid styling hooks off the attribute, which the Input does not set itself', () => {
    render(<Input aria-label="x" />)
    expect(screen.getByLabelText('x').hasAttribute('aria-invalid')).toBe(false)
  })
})
