// [[UI458]] cycle 1, group 4 (D11): ChoiceGroup is one native choice.
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, userEvent } from '#render'
import { ChoiceGroup, type ChoiceGroupProps } from './choice-group'

const noViolations = async () => {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
}

const props: ChoiceGroupProps = {
  legend: 'What to capture',
  name: 'capture',
  options: [
    { value: 'all', label: 'Everything', description: 'Every message in the mailbox.' },
    { value: 'labels', label: 'Chosen labels' },
  ],
  value: 'all',
  onChange: () => {},
}

describe('ChoiceGroup', () => {
  it('is a fieldset named by its legend with one labelled radio per option and a linked description', () => {
    const { container } = render(<ChoiceGroup {...props} />)
    const group = screen.getByRole('group', { name: 'What to capture' })
    expect(group.tagName).toBe('FIELDSET')
    expect(container.querySelector('fieldset > legend')?.textContent).toBe('What to capture')
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(screen.getByRole('radio', { name: 'Everything' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Everything' }).getAttribute('aria-describedby')).toBeTruthy()
    const id = screen.getByRole('radio', { name: 'Everything' }).getAttribute('aria-describedby') as string
    expect(document.getElementById(id)?.textContent).toBe('Every message in the mailbox.')
    expect(screen.getByRole('radio', { name: 'Chosen labels' }).hasAttribute('aria-describedby')).toBe(false)
  })

  it('the checked radio follows the value; choosing another reports its value', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<ChoiceGroup {...props} onChange={onChange} />)
    expect((screen.getByRole('radio', { name: 'Everything' }) as HTMLInputElement).checked).toBe(true)
    await userEvent.click(screen.getByRole('radio', { name: 'Chosen labels' }))
    expect(onChange).toHaveBeenCalledWith('labels')
    rerender(<ChoiceGroup {...props} onChange={onChange} value="labels" />)
    expect((screen.getByRole('radio', { name: 'Chosen labels' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'Everything' }) as HTMLInputElement).checked).toBe(false)
  })

  it('read-only renders the chosen option label and no inputs', () => {
    const { container } = render(<ChoiceGroup {...props} value="labels" readOnly />)
    expect(container.textContent).toBe('Chosen labels')
    expect(container.querySelector('input')).toBeNull()
  })

  it('has axe zero violations: editable and read-only', async () => {
    const { unmount } = render(
      <>
        <h1>Page</h1>
        <ChoiceGroup {...props} />
      </>,
    )
    await noViolations()
    unmount()
    render(
      <>
        <h1>Page</h1>
        <ChoiceGroup {...props} readOnly />
      </>,
    )
    await noViolations()
  })
})
