// [[UI443]] cycle 1, group 3 (D11): the page frame orders and announces.
import axe from 'axe-core'
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '#render'
import { SettingsPage } from './settings-page'
import { SettingsRow } from './settings-row'
import { SettingsSection } from './settings-section'

const noViolations = async () => {
  const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
}

describe('SettingsPage', () => {
  it('renders one h1 with the title, the description and the actions', () => {
    const { container } = render(
      <SettingsPage title="Home" description="Your workspace" actions={<button type="button">Act</button>}>
        <p>Body</p>
      </SettingsPage>,
    )
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Home')
    expect(screen.getByText('Your workspace')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Act' })).toBeTruthy()
    expect(screen.getByText('Body')).toBeTruthy()
  })

  it('a page error shows in an error Alert that takes focus when it appears and again when it changes', async () => {
    const { rerender } = render(<SettingsPage title="Home">x</SettingsPage>)
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(
      <SettingsPage title="Home" error="First">
        x
      </SettingsPage>,
    )
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('First')
    await waitFor(() => expect(document.activeElement).toBe(alert))
    ;(document.activeElement as HTMLElement).blur()
    rerender(
      <SettingsPage title="Home" error="First">
        y
      </SettingsPage>,
    )
    expect(document.activeElement).not.toBe(screen.getByRole('alert'))
    rerender(
      <SettingsPage title="Home" error="Second">
        y
      </SettingsPage>,
    )
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')))
    expect(screen.getByRole('alert').textContent).toBe('Second')
  })

  it('loading sets aria-busy on the region and clears it after', () => {
    const { rerender } = render(
      <SettingsPage title="Home" loading>
        x
      </SettingsPage>,
    )
    const region = screen.getByRole('region', { name: 'Home' })
    expect(region.getAttribute('aria-busy')).toBe('true')
    rerender(<SettingsPage title="Home">x</SettingsPage>)
    expect(screen.getByRole('region', { name: 'Home' }).hasAttribute('aria-busy')).toBe(false)
  })

  it('has axe zero violations: plain, loading and with an error', async () => {
    const { rerender } = render(<SettingsPage title="Home">x</SettingsPage>)
    await noViolations()
    rerender(
      <SettingsPage title="Home" loading>
        x
      </SettingsPage>,
    )
    await noViolations()
    rerender(
      <SettingsPage title="Home" error="Boom">
        x
      </SettingsPage>,
    )
    await noViolations()
  })
})

describe('SettingsSection and SettingsRow', () => {
  it('a section renders an h2 under the page title', () => {
    render(
      <SettingsPage title="Home">
        <SettingsSection title="Who you are" description="Your account">
          <p>x</p>
        </SettingsSection>
      </SettingsPage>,
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Who you are' })).toBeTruthy()
    expect(screen.getByText('Your account')).toBeTruthy()
  })

  it('read-only rows form a dl of dt/dd pairs', () => {
    const { container } = render(
      <SettingsSection title="Who you are" readOnly>
        <SettingsRow label="Name">Ada</SettingsRow>
        <SettingsRow label="Role" description="Set by the owner">
          Owner
        </SettingsRow>
      </SettingsSection>,
    )
    const dl = container.querySelector('dl')!
    expect(dl).toBeTruthy()
    expect(Array.from(dl.querySelectorAll('dt')).map((e) => e.textContent)).toEqual(['Name', 'Role'])
    expect(Array.from(dl.querySelectorAll('dd')).map((e) => e.textContent)).toEqual(['Ada', 'OwnerSet by the owner'])
  })

  it('a row with a control labels it and is no dl', () => {
    const { container } = render(
      <SettingsSection title="Profile">
        <SettingsRow label="Display name" htmlFor="dn">
          <input id="dn" />
        </SettingsRow>
      </SettingsSection>,
    )
    expect(container.querySelector('dl')).toBeNull()
    expect(screen.getByLabelText('Display name')).toBeTruthy()
  })

  it('has axe zero violations for both kinds of section', async () => {
    render(
      <main>
        <SettingsPage title="Home">
          <SettingsSection title="Who you are" readOnly>
            <SettingsRow label="Name">Ada</SettingsRow>
          </SettingsSection>
          <SettingsSection title="Profile">
            <SettingsRow label="Display name" htmlFor="dn">
              <input id="dn" />
            </SettingsRow>
          </SettingsSection>
        </SettingsPage>
      </main>,
    )
    await noViolations()
  })
})
