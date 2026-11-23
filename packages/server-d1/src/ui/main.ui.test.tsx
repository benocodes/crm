// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

// [[UI446]] E2E fix 1: the mount renders synchronously (flushSync), as Preact's `render` did. A page that takes its token from the address fragment has removed it by the time the module
// has run, not a scheduler tick later (`e2e:auth-pages` step 7 reads the hash right after the document loads).
afterEach(() => {
  vi.resetModules()
  document.body.innerHTML = ''
})

describe('the mount', () => {
  it('renders the page and has taken the reset token out of the address before the module returns', async () => {
    document.body.innerHTML = '<main id="root"></main>'
    history.replaceState(null, '', '/app/reset-password#token=bogus')
    await import('./main.js')
    expect(location.hash).toBe('')
    expect(document.querySelector('#root')?.textContent).toContain('Set a new password')
    expect(document.title).toBe('Set a new password - Vibase')
  })
})
