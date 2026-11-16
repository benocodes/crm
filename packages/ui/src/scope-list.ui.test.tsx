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
    const { container } = render(
      <ScopeList scopes={[{ name: attack, description: '<b>bold</b><script>1</script>' }]} />,
    )
    expect(container.querySelector('img, b, script')).toBeNull()
    expect(screen.getByText(attack)).toBeTruthy()
    expect(container.textContent).toContain('<b>bold</b><script>1</script>')
  })

  // [[UI381]] D10: a bounded, named, keyboard-focusable scroll region
  it('sits in a named region that is keyboard focusable, and still lists every scope', () => {
    const scopes = Array.from({ length: 30 }, (_, i) => ({ name: `s${i}:read`, description: `d${i}` }))
    render(<ScopeList scopes={scopes} />)
    const region = screen.getByRole('region', { name: /permissions/i })
    expect(region.getAttribute('tabindex')).toBe('0')
    expect(region.querySelectorAll('li')).toHaveLength(30)
    expect(region.className).toContain('vb-scope-list__region')
  })
})
