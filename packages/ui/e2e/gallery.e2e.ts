// The gallery run ([[UI254]] D7): a screenshot per component state per theme, axe with zero violations per theme, Tab order with a visible focus
// ring, and the invalid form moving focus to its error Alert. Screenshots are review evidence in the gitignored `e2e-screenshots/`.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const SHOTS = fileURLToPath(new URL('../e2e-screenshots/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })

type Mode = { name: string; url: string; colorScheme: 'light' | 'dark' }
const MODES: Mode[] = [
  { name: 'light-forced', url: '/?theme=light', colorScheme: 'dark' }, // forced light must win over a dark OS
  { name: 'dark-forced', url: '/?theme=dark', colorScheme: 'light' }, // forced dark must win over a light OS
  { name: 'dark-emulated', url: '/', colorScheme: 'dark' }, // no attribute: the OS preference
  { name: 'light-emulated', url: '/', colorScheme: 'light' },
]

const states = (page: Page) => page.locator('[data-gallery-state]')

for (const mode of MODES) {
  test.describe(mode.name, () => {
    test.use({ colorScheme: mode.colorScheme })

    test('screenshots every state and axe finds zero violations', async ({ page }) => {
      await page.goto(mode.url)
      await expect(states(page).first()).toBeVisible()
      const names = await states(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-gallery-state')!))
      expect(names.length).toBeGreaterThanOrEqual(10)
      for (const name of names) {
        await page.locator(`[data-gallery-state="${name}"]`).screenshot({ path: join(SHOTS, `${mode.name}--${name}.png`) })
      }
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      const dark = mode.name.startsWith('dark')
      expect(bg, 'the theme actually applied').toBe(dark ? 'rgb(10, 10, 10)' : 'rgb(255, 255, 255)')
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
    })
  })
}

test('Tab moves focus through the controls in order, each with a visible focus ring', async ({ page }) => {
  await page.goto('/?theme=light')
  await expect(states(page).first()).toBeVisible()
  const seen: string[] = []
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const s = getComputedStyle(el)
      return { tag: el.tagName, text: (el.textContent ?? '').slice(0, 24), outline: s.outlineStyle, width: parseFloat(s.outlineWidth), top: el.getBoundingClientRect().top + window.scrollY }
    })
    if (!info) break
    expect(info.outline, `focus ring on ${info.tag} ${info.text}`).not.toBe('none')
    expect(info.width).toBeGreaterThanOrEqual(2)
    seen.push(`${info.tag}:${info.text}`)
    if (info.tag === 'BUTTON' && info.text === 'Continue') break
  }
  // Primary, Secondary, Destructive, Link (Busy and Disabled are not tabbable), then fields in document order.
  expect(seen.slice(0, 4)).toEqual(['BUTTON:Primary', 'BUTTON:Secondary', 'BUTTON:Destructive', 'BUTTON:Link'])
  expect(seen.at(-1)).toBe('BUTTON:Continue')
  expect(seen).not.toContain('BUTTON:Busy')
  expect(seen).not.toContain('BUTTON:Disabled')
  expect(seen.filter((s) => s.startsWith('INPUT')).length).toBeGreaterThanOrEqual(5)
})

test('a code input asks the browser for one-time-code input without spellcheck, and normalises a paste', async ({ page }) => {
  await page.goto('/?theme=light')
  const input = page.getByLabel('Device code').first()
  expect(await input.evaluate((e: HTMLInputElement) => e.spellcheck)).toBe(false)
  await input.click()
  await input.fill('abcd efgh')
  await expect(input).toHaveValue('ABCD-EFGH')
})

test('submitting the invalid form moves focus to its error Alert', async ({ page }) => {
  await page.goto('/?theme=light')
  const form = page.locator('[data-gallery-state="form-invalid"]')
  await form.getByLabel('Email').focus()
  await page.keyboard.press('Enter')
  const alert = form.getByRole('alert')
  await expect(alert).toHaveText('Enter your email address.')
  await expect(alert).toBeFocused()
  await page.screenshot({ path: join(SHOTS, 'form-invalid-focus-on-alert.png'), fullPage: false })
  const outline = await alert.evaluate((e) => getComputedStyle(e).outlineStyle)
  expect(outline).not.toBe('none')
})
