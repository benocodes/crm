import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen, userEvent } from '#render'
import { CodeInput, normaliseCode } from './code-input'

function Controlled(props: { groupLength?: number; error?: string }) {
  const [value, setValue] = useState('')
  return <CodeInput label="Code" value={value} onChange={setValue} {...props} />
}

describe('normaliseCode', () => {
  it.each([
    ['abcd-efgh', 'ABCD-EFGH'],
    ['ABCDEFGH', 'ABCD-EFGH'],
    ['  abcd-efgh  ', 'ABCD-EFGH'],
    ['abcd efgh', 'ABCD-EFGH'],
    ['ab', 'AB'],
    ['abcd', 'ABCD'],
    ['abcde', 'ABCD-E'],
    ['', ''],
  ])('%j -> %j', (raw, expected) => {
    expect(normaliseCode(raw)).toBe(expected)
  })

  it('takes the group length as a parameter', () => {
    expect(normaliseCode('abcdef', 3)).toBe('ABC-DEF')
  })
})

describe('CodeInput', () => {
  it('is one input with the one-time-code attributes', () => {
    const { container } = render(<Controlled />)
    expect(container.querySelectorAll('input')).toHaveLength(1)
    const input = screen.getByLabelText('Code')
    expect(input.getAttribute('autocomplete')).toBe('one-time-code')
    expect(input.getAttribute('autocapitalize')).toBe('characters')
    expect(input.getAttribute('spellcheck')).toBe('false')
  })

  it('wires a format hint by aria-describedby', () => {
    render(<Controlled />)
    const ids = (screen.getByLabelText('Code').getAttribute('aria-describedby') ?? '').split(' ')
    expect(document.getElementById(ids[0]!)?.textContent).toContain('ABCD-WXYZ')
  })

  it('upper-cases typed lower-case', async () => {
    render(<Controlled />)
    const input = screen.getByLabelText('Code') as HTMLInputElement
    await userEvent.setup().type(input, 'abcd')
    expect(input.value).toBe('ABCD')
  })

  it.each(['abcd-efgh', 'abcdefgh', '  abcd-efgh '])('a pasted %j gives the same normalised value', async (pasted) => {
    render(<Controlled />)
    const input = screen.getByLabelText('Code') as HTMLInputElement
    const user = userEvent.setup()
    await user.click(input)
    await user.paste(pasted)
    expect(input.value).toBe('ABCD-EFGH')
  })

  it('aria-invalid and the error id appear only with an error', () => {
    const { unmount } = render(<Controlled />)
    expect(screen.getByLabelText('Code').hasAttribute('aria-invalid')).toBe(false)
    unmount()
    render(<Controlled error="Unknown code" />)
    const input = screen.getByLabelText('Code')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids).toHaveLength(2)
    expect(document.getElementById(ids[1]!)?.textContent).toBe('Unknown code')
  })
})
