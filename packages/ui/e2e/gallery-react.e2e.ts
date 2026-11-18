// The React gallery run ([[UI445]] E2E): four theme modes, a screenshot each, axe with zero violations, a visible focus ring on the native
// button and input, and zero CSP violations throughout. Screenshots are review evidence in the gitignored `e2e-screenshots/`.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

const SHOTS = fileURLToPath(new URL('../e2e-screenshots/react/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })

const MODES = [
  { name: 'light-forced', url: '/?theme=light', colorScheme: 'dark' as const }, // forced light wins over a dark OS
  { name: 'dark-forced', url: '/?theme=dark', colorScheme: 'light' as const }, // forced dark wins over a light OS
  { name: 'dark-emulated', url: '/', colorScheme: 'dark' as const },
  { name: 'light-emulated', url: '/', colorScheme: 'light' as const },
]

/** Collects CSP violations (browser event and console errors) for the whole page life; the page's own listener is installed before any script. */
async function watchCsp(page: Page) {
  const found: string[] = []
  await page.addInitScript(() => {
    ;(window as unknown as { __csp: string[] }).__csp = []
    document.addEventListener('securitypolicyviolation', (e) => {
      ;(window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`)
    })
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && /content security policy/i.test(m.text())) found.push(m.text())
  })
  return async () => [...found, ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp))]
}

for (const mode of MODES) {
  test.describe(mode.name, () => {
    test.use({ colorScheme: mode.colorScheme })

    test('renders in the theme, axe finds zero violations, no CSP violation', async ({ page }) => {
      const csp = await watchCsp(page)
      await page.goto(mode.url)
      await expect(page.locator('[data-gallery-state]').first()).toBeVisible()
      await page.screenshot({ path: join(SHOTS, `${mode.name}.png`), fullPage: true })
      const dark = mode.name.startsWith('dark')
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'the theme applied').toBe(
        dark ? 'rgb(10, 10, 10)' : 'rgb(255, 255, 255)',
      )
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
      expect(await csp()).toEqual([])
    })
  })
}

test('Tab reaches the native buttons and the input, each with a visible focus ring', async ({ page }) => {
  const csp = await watchCsp(page)
  await page.goto('/?theme=light')
  await expect(page.locator('[data-gallery-state]').first()).toBeVisible()
  const seen: string[] = []
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const s = getComputedStyle(el)
      return {
        tag: el.tagName,
        text: (el.textContent ?? '').slice(0, 24),
        outline: s.outlineStyle,
        width: parseFloat(s.outlineWidth),
        shadow: s.boxShadow,
      }
    })
    expect(info.outline, `outline on ${info.tag}`).not.toBe('none')
    expect(info.width).toBeGreaterThanOrEqual(2)
    expect(info.shadow, `ring on ${info.tag}`).not.toBe('none')
    seen.push(`${info.tag}:${info.text}`)
    await page.screenshot({ path: join(SHOTS, `focus-${i}.png`) })
  }
  expect(seen).toEqual(['BUTTON:Primary', 'BUTTON:Destructive', 'INPUT:'])
  expect(await csp()).toEqual([])
})
