import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen, userEvent } from '#render'
import { Field } from './field'

function Controlled(props: { hint?: string; error?: string; autoComplete?: string }) {
  const [value, setValue] = useState('')
  return <Field label="Email" type="email" value={value} onChange={setValue} {...props} />
}

describe('Field', () => {
  it('associates the label with the input', () => {
    render(<Controlled />)
    expect(screen.getByLabelText('Email').tagName).toBe('INPUT')
  })

  it('has no aria-invalid and no aria-describedby with neither error nor hint (absent, not "false")', () => {
    render(<Controlled />)
    const input = screen.getByLabelText('Email')
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.hasAttribute('aria-describedby')).toBe(false)
  })

  it('aria-invalid is "true" only with an error, and aria-describedby is the error id alone', () => {
    render(<Controlled error="Enter an email" />)
    const input = screen.getByLabelText('Email')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids).toHaveLength(1)
    expect(document.getElementById(ids[0]!)?.textContent).toBe('Enter an email')
  })

  it('aria-describedby is the hint alone when there is only a hint', () => {
    render(<Controlled hint="Work address" />)
    const input = screen.getByLabelText('Email')
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(['Work address'])
  })

  it('aria-describedby lists the hint then the error', () => {
    render(<Controlled hint="Work address" error="Enter an email" />)
    const ids = (screen.getByLabelText('Email').getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(['Work address', 'Enter an email'])
  })

  it('passes autoComplete through', () => {
    render(<Controlled autoComplete="current-password" />)
    expect(screen.getByLabelText('Email').getAttribute('autocomplete')).toBe('current-password')
  })

  it('is controlled: typing calls onChange per keystroke and updates the value', async () => {
    render(<Controlled />)
    const input = screen.getByLabelText('Email') as HTMLInputElement
    await userEvent.setup().type(input, 'a@b.co')
    expect(input.value).toBe('a@b.co')
  })

  it('gives each field its own ids', () => {
    render(
      <>
        <Field label="One" value="" onChange={() => {}} hint="h1" />
        <Field label="Two" value="" onChange={() => {}} hint="h2" />
      </>,
    )
    expect(screen.getByLabelText('One').id).not.toBe(screen.getByLabelText('Two').id)
    expect(screen.getByLabelText('One').getAttribute('aria-describedby')).not.toBe(screen.getByLabelText('Two').getAttribute('aria-describedby'))
  })
})
