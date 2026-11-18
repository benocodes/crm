// [[UI458]] cycle 1, group 3 (D11): ListEditor edits a list and refuses bad entries.
import axe from 'axe-core'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, userEvent } from '#render'
import { ListEditor, type ListEditorProps } from './list-editor'

const noViolations = async () => {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
}

const base: ListEditorProps = {
  label: 'Domains',
  values: [],
  onChange: () => {},
  addLabel: 'Add',
  emptyText: 'Nothing listed.',
  emptyEntryMessage: 'Enter a value.',
  duplicateMessage: 'Already in the list.',
  maxMessage: 'No more than 3.',
}

/** Holds the list like a page would and records every reported change. */
function Host({ initial = [] as string[], onChange, ...rest }: Partial<ListEditorProps> & { initial?: string[] }) {
  const [values, setValues] = useState(initial)
  return (
    <>
      <h1>Page</h1>
      <ListEditor
        {...base}
        {...rest}
        values={values}
        onChange={(v) => {
          setValues(v)
          onChange?.(v)
        }}
      />
    </>
  )
}
const field = () => screen.getByRole('textbox', { name: 'Domains' })

describe('ListEditor', () => {
  it('adds by the button and by Enter; each change reports the whole list', async () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} initial={['a.com']} />)
    await userEvent.type(field(), 'b.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).toHaveBeenLastCalledWith(['a.com', 'b.com'])
    expect((field() as HTMLInputElement).value).toBe('')
    await userEvent.type(field(), 'c.com{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(['a.com', 'b.com', 'c.com'])
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('removes by a button whose name includes the value, reporting the whole list', async () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} initial={['a.com', 'b.com']} removeLabel="Remove" />)
    await userEvent.click(screen.getByRole('button', { name: /Remove.*a\.com/ }))
    expect(onChange).toHaveBeenLastCalledWith(['b.com'])
    expect(screen.queryByText('a.com')).toBeNull()
  })

  it('refuses an empty entry inline, tied to the field, list unchanged and nothing reported', async () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} initial={['a.com']} />)
    await userEvent.type(field(), '   {Enter}')
    expect(onChange).not.toHaveBeenCalled()
    const message = screen.getByText('Enter a value.')
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(field().getAttribute('aria-describedby')?.split(' ')).toContain(message.id)
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('refuses a duplicate inline; trims; compares case-insensitively (pinned on the second value)', async () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} initial={['a.com']} />)
    await userEvent.type(field(), '  B.com {Enter}')
    expect(onChange).toHaveBeenLastCalledWith(['a.com', 'B.com'])
    onChange.mockClear()
    await userEvent.type(field(), 'b.COM{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('Already in the list.')).toBeTruthy()
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('the refusal clears when the person types again', async () => {
    render(<Host initial={['a.com']} />)
    await userEvent.type(field(), 'a.com{Enter}')
    expect(screen.getByText('Already in the list.')).toBeTruthy()
    await userEvent.type(field(), 'x')
    expect(screen.queryByText('Already in the list.')).toBeNull()
    expect(field().hasAttribute('aria-invalid')).toBe(false)
  })

  it('at max an add is refused with a message', async () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} initial={['a', 'b', 'c']} max={3} />)
    await userEvent.type(field(), 'd{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('No more than 3.')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('read-only renders the values as a list with no inputs, and its empty text when empty', () => {
    const { rerender } = render(<ListEditor {...base} values={['a.com', 'b.com']} readOnly />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<ListEditor {...base} values={[]} readOnly />)
    expect(screen.getByText('Nothing listed.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('has axe zero violations: editable, refusing, read-only', async () => {
    const { unmount } = render(<Host initial={['a.com']} />)
    await noViolations()
    await userEvent.type(field(), 'a.com{Enter}')
    await noViolations()
    unmount()
    render(
      <>
        <h1>Page</h1>
        <ListEditor {...base} values={['a.com']} readOnly />
      </>,
    )
    await noViolations()
  })
})
