// [[UI448]] group 1: the Alert composite's roles and focusability.
import { describe, expect, it } from 'vitest'
import { render, screen } from '#render'
import { Alert } from './alert'

describe('Alert', () => {
  it('error is role="alert"', () => {
    render(<Alert variant="error">Nope</Alert>)
    expect(screen.getByRole('alert').textContent).toBe('Nope')
  })

  it.each(['info', 'success'] as const)('%s is role="status"', (variant) => {
    render(<Alert variant={variant}>Fine</Alert>)
    expect(screen.getByRole('status').textContent).toBe('Fine')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('defaults to info (role="status")', () => {
    render(<Alert>Note</Alert>)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('is focusable by script (tabindex -1) and not by Tab, so a form can move focus to it', () => {
    render(<Alert variant="error">Nope</Alert>)
    const el = screen.getByRole('alert')
    expect(el.getAttribute('tabindex')).toBe('-1')
    el.focus()
    expect(document.activeElement).toBe(el)
  })
})
