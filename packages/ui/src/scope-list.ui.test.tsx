import { describe, expect, it } from 'vitest'
import { render, screen } from '#render'
import { ScopeList } from './scope-list'

describe('ScopeList', () => {
  it('renders each scope name with its description', () => {
    render(
      <ScopeList
        scopes={[
          { name: 'contacts:read', description: 'Read contacts' },
          { name: 'contacts:write', description: 'Create and change contacts' },
        ]}
      />,
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('contacts:read')).toBeTruthy()
    expect(screen.getByText('Create and change contacts')).toBeTruthy()
  })

  it('renders markup-looking names and descriptions as text: no element is created from them', () => {
    const attack = '<img src=x onerror=alert(1)>'
    const { container } = render(<ScopeList scopes={[{ name: attack, description: '<b>bold</b><script>1</script>' }]} />)
    expect(container.querySelector('img, b, script')).toBeNull()
    expect(screen.getByText(attack)).toBeTruthy()
    expect(container.textContent).toContain('<b>bold</b><script>1</script>')
  })
})
