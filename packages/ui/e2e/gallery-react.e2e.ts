// The React gallery run ([[UI445]] E2E): four theme modes, a screenshot each, axe with zero violations, a visible focus ring on the native
// button and input, and zero CSP violations throughout. Screenshots are review evidence in the gitignored `e2e-screenshots/`.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { APP_CSP, PAGE_CSP } from '../src/csp'

const SHOTS = fileURLToPath(new URL('../e2e-screenshots/react/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })

const MODES = [
  { name: 'light-forced', url: '/?theme=light', colorScheme: 'dark' as const }, // forced light wins over a dark OS
  { name: 'dark-forced', url: '/?theme=dark', colorScheme: 'light' as const }, // forced dark wins over a light OS
  { name: 'dark-emulated', url: '/', colorScheme: 'dark' as const },
  { name: 'light-emulated', url: '/', colorScheme: 'light' as const },
]

const SECTIONS = [
  'buttons',
  'input-label',
  'switch',
  'field',
  'code-input',
  'alert',
  'card',
  'scope-list',
  'form-layout',
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
      for (const state of SECTIONS) {
        await page
          .locator(`[data-gallery-state="${state}"]`)
          .screenshot({ path: join(SHOTS, `${mode.name}-${state}.png`) })
      }
      const dark = mode.name.startsWith('dark')
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'the theme applied').toBe(
        dark ? 'rgb(10, 10, 10)' : 'rgb(255, 255, 255)',
      )
      const switchBg = (name: string) =>
        page
          .locator('[data-gallery-state="switch"]')
          .getByRole('switch', { name, exact: true })
          .evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(await switchBg('On'), 'an on Switch looks different from an off one in this mode').not.toBe(
        await switchBg('Off'),
      )
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
      expect(await csp()).toEqual([])
    })
  })
}

test('Tab reaches every focusable element, each with a visible focus ring (outline and ring)', async ({ page }) => {
  const csp = await watchCsp(page)
  await page.goto('/?theme=light')
  await expect(page.locator('[data-gallery-state]').first()).toBeVisible()
  // Radix's Switch renders a hidden `aria-hidden` bubble input inside a form: it is no Tab stop.
  const expected = await page.evaluate(
    () =>
      document.querySelectorAll('button:not(:disabled), input:not(:disabled):not([aria-hidden="true"]), [tabindex="0"]')
        .length,
  )
  expect(expected).toBeGreaterThan(12)
  const seen = new Set<string>()
  for (let i = 0; i < expected; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate((n) => {
      const el = document.activeElement as HTMLElement
      const s = getComputedStyle(el)
      el.setAttribute('data-focus-seen', String(n))
      return {
        tag: el.tagName,
        label: el.getAttribute('aria-label') ?? el.textContent?.slice(0, 20) ?? el.id,
        outline: s.outlineStyle,
        width: parseFloat(s.outlineWidth),
        shadow: s.boxShadow,
      }
    }, i)
    expect(info.outline, `outline on ${info.tag} ${info.label}`).not.toBe('none')
    expect(info.width, `outline width on ${info.tag} ${info.label}`).toBeGreaterThanOrEqual(2)
    expect(info.shadow, `ring on ${info.tag} ${info.label}`).not.toBe('none')
    seen.add(`${i}`)
    if (i % 4 === 0) await page.screenshot({ path: join(SHOTS, `focus-${i}.png`) })
  }
  expect(seen.size).toBe(expected)
  expect(await page.locator('[data-focus-seen]').count(), 'each Tab stop was a different element').toBe(expected)
  expect(await csp()).toEqual([])
})

test('the Switch: Tab reaches it, a click turns it on (visibly), a disabled one does not change', async ({ page }) => {
  const csp = await watchCsp(page)
  await page.goto('/?theme=light')
  const section = page.locator('[data-gallery-state="switch"]')
  const off = section.getByRole('switch', { name: 'Off', exact: true })
  const on = section.getByRole('switch', { name: 'On', exact: true })
  const disabledOff = section.getByRole('switch', { name: 'Disabled, off' })
  const disabledOn = section.getByRole('switch', { name: 'Disabled, on' })
  await expect(section.getByRole('switch')).toHaveCount(5)
  const bg = (l: typeof off) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
  const offBg = await bg(off)
  expect(await bg(on), 'the on state is visibly distinct from off').not.toBe(offBg)
  // Tab until the Off switch has focus, then check its ring.
  for (let i = 0; i < 40 && !(await off.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab')
  expect(await off.evaluate((el) => el === document.activeElement)).toBe(true)
  const ring = await off.evaluate((el) => {
    const s = getComputedStyle(el)
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), shadow: s.boxShadow }
  })
  expect(ring.style).not.toBe('none')
  expect(ring.width).toBeGreaterThanOrEqual(2)
  expect(ring.shadow).not.toBe('none')
  await page.keyboard.press('Space')
  await expect(off).toHaveAttribute('aria-checked', 'true')
  await expect
    .poll(async () => bg(off), { message: 'the clicked switch takes the on styling (after its transition)' })
    .toBe(await bg(on))
  await disabledOff.click({ force: true })
  await disabledOn.click({ force: true })
  await expect(disabledOff).toHaveAttribute('aria-checked', 'false')
  await expect(disabledOn).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: join(SHOTS, 'switch.png') })
  expect(await csp()).toEqual([])
})

test('the invalid FormLayout moves focus to its error Alert', async ({ page }) => {
  const csp = await watchCsp(page)
  await page.goto('/?theme=light')
  const form = page.locator('[data-gallery-state="form-layout"]')
  await form.getByLabel('Your email').click()
  await page.keyboard.press('Enter')
  const alert = form.getByRole('alert')
  await expect(alert).toHaveText('Enter your email address.')
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('alert')
  expect(await alert.evaluate((el) => el === document.activeElement)).toBe(true)
  await page.screenshot({ path: join(SHOTS, 'form-error-focus.png') })
  expect(await csp()).toEqual([])
})

test('CodeInput normalises a pasted code to ABCD-EFGH and is not spell-checked', async ({ page }) => {
  await page.goto('/?theme=light')
  const input = page.getByLabel('Code (empty)')
  await input.fill(' abcd efgh ')
  await expect(input).toHaveValue('ABCD-EFGH')
  expect(await input.evaluate((el: HTMLInputElement) => el.spellcheck)).toBe(false)
})

// ---- [[UI443]] cycle 1: the composites page, served with APP_CSP ----

const COMPOSITE_STATES = [
  'page-plain',
  'page-actions',
  'page-error',
  'page-loading',
  'sections',
  'prompt-link',
  'prompt-button',
  'command',
]
const VIEWS = [
  { view: 'parts', states: COMPOSITE_STATES },
  { view: 'shell', states: ['shell', ...COMPOSITE_STATES.slice(4)] },
  { view: 'shell-bare', states: ['shell-bare'] },
]

for (const mode of MODES) {
  for (const { view, states } of VIEWS) {
    test.describe(`composites ${view} ${mode.name}`, () => {
      test.use({ colorScheme: mode.colorScheme })

      test('renders in the theme, axe finds zero violations, no CSP violation', async ({ page }) => {
        const csp = await watchCsp(page)
        const theme = mode.url.includes('theme=') ? `&${mode.url.split('?')[1]}` : ''
        await page.goto(`/composites?view=${view}${theme}`)
        await expect(page.locator('[data-gallery-state]').first()).toBeVisible()
        await page.screenshot({ path: join(SHOTS, `composites-${view}-${mode.name}.png`), fullPage: true })
        for (const state of states) {
          await page
            .locator(`[data-gallery-state="${state}"]`)
            .first()
            .screenshot({ path: join(SHOTS, `composites-${view}-${mode.name}-${state}.png`) })
        }
        const dark = mode.name.startsWith('dark')
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'the theme applied').toBe(
          dark ? 'rgb(10, 10, 10)' : 'rgb(255, 255, 255)',
        )
        const results = await new AxeBuilder({ page }).analyze()
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual(
          [],
        )
        expect(await csp()).toEqual([])
      })
    })
  }
}

test('Tab through the shell: the skip link first, Enter moves focus into main, every stop has a focus ring', async ({
  page,
}) => {
  const csp = await watchCsp(page)
  await page.goto('/composites?view=shell&theme=light')
  await expect(page.getByRole('main')).toBeVisible()
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to main content' })
  expect(await skip.evaluate((el) => el === document.activeElement), 'the skip link is the first Tab stop').toBe(true)
  await expect(skip).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'composites-skip-link.png') })
  await page.keyboard.press('Enter')
  expect(await page.getByRole('main').evaluate((el) => el === document.activeElement)).toBe(true)
  // Walk every Tab stop from the top of a fresh load: each shows an outline and a ring.
  await page.goto('/composites?view=shell&theme=light')
  const expected = await page.evaluate(
    () =>
      document.querySelectorAll(
        'a[href]:not(.sr-only), button:not(:disabled), input:not(:disabled):not([aria-hidden="true"]), [role="switch"]:not(:disabled)',
      ).length + 1, // the skip link is sr-only until focused
  )
  for (let i = 0; i < expected; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const s = getComputedStyle(el)
      return {
        label: el.textContent?.slice(0, 20) ?? el.id,
        outline: s.outlineStyle,
        width: parseFloat(s.outlineWidth),
        shadow: s.boxShadow,
      }
    })
    expect(info.outline, `outline on ${info.label}`).not.toBe('none')
    expect(info.width, `outline width on ${info.label}`).toBeGreaterThanOrEqual(2)
    expect(info.shadow, `ring on ${info.label}`).not.toBe('none')
  }
  expect(await csp()).toEqual([])
})

test('CommandBlock: Copy puts exactly the command on the Clipboard and announces Copied', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  const csp = await watchCsp(page)
  await page.goto('/composites?theme=light')
  const block = page.locator('[data-gallery-state="command"]')
  await expect(block.locator('code')).toHaveText('<b>x</b> & "q"')
  expect(await block.locator('b').count(), 'the markup characters stayed text').toBe(0)
  await block.screenshot({ path: join(SHOTS, 'composites-command-before.png') })
  await block.getByRole('button', { name: 'Copy' }).click()
  await expect(block.getByRole('status')).toHaveText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('<b>x</b> & "q"')
  await block.screenshot({ path: join(SHOTS, 'composites-command-after.png') })
  expect(await csp()).toEqual([])
  await context.close()
})

test('SettingsPage: raising an error moves focus to its alert', async ({ page }) => {
  const csp = await watchCsp(page)
  await page.goto('/composites?theme=light')
  const state = page.locator('[data-gallery-state="page-error"]')
  await state.getByRole('button', { name: 'Raise a page error' }).click()
  const alert = state.getByRole('alert')
  await expect(alert).toHaveText('Could not load agents.')
  expect(await alert.evaluate((el) => el === document.activeElement)).toBe(true)
  expect(await csp()).toEqual([])
})

test('at 375 px the shell is a row of links above the page: no sidebar, no horizontal scroll', async ({ page }) => {
  const csp = await watchCsp(page)
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto('/composites?view=shell&theme=light')
  const nav = page.getByRole('navigation', { name: 'Workspace' })
  const boxes = await nav.getByRole('link').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()))
  expect(boxes.length).toBe(3)
  expect(new Set(boxes.map((b) => Math.round(b.top))).size, 'the entries share one row').toBe(1)
  expect(await nav.evaluate((el) => getComputedStyle(el).flexDirection)).toBe('row')
  const aside = await page
    .locator('aside')
    .evaluate((el) => ({ width: el.getBoundingClientRect().width, right: getComputedStyle(el).borderRightWidth }))
  expect(aside.width, 'no sidebar column: the aside spans the page').toBeGreaterThanOrEqual(370)
  expect(aside.right).toBe('0px')
  const mainTop = await page.getByRole('main').evaluate((el) => el.getBoundingClientRect().top)
  expect(mainTop, 'the page sits below the row of links').toBeGreaterThan(boxes[0]!.bottom)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: join(SHOTS, 'composites-shell-375.png'), fullPage: true })
  await page.setViewportSize({ width: 1100, height: 800 })
  expect(await nav.evaluate((el) => getComputedStyle(el).flexDirection), 'from md it is a sidebar column').toBe(
    'column',
  )
  expect(await csp()).toEqual([])
})

test('each page is served with its own policy: PAGE_CSP on the components page, APP_CSP on the composites page', async ({
  page,
}) => {
  const components = await page.goto('/')
  expect(components?.headers()['content-security-policy']).toBe(PAGE_CSP)
  const composites = await page.goto('/composites')
  expect(composites?.headers()['content-security-policy']).toBe(APP_CSP)
})

/** Inserts a `<style>` element and an inline `<script>` at runtime, as a library or an attacker would; returns the violated directives. */
async function injectedViolations(page: Page, url: string) {
  await page.goto(url)
  await expect(page.locator('[data-gallery-state]').first()).toBeVisible()
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = 'body{outline:3px solid red}'
    document.head.append(style)
    const script = document.createElement('script')
    script.textContent = 'window.__ran = true'
    document.head.append(script)
  })
  await page.waitForTimeout(200)
  const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)
  const ran = await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran === true)
  return { violations, ran }
}

test('an injected <style> is a violation on the components page only; an injected inline <script> on both', async ({
  page,
}) => {
  await watchCsp(page)
  const components = await injectedViolations(page, '/')
  expect(components.violations.some((v) => v.startsWith('style-src-elem'))).toBe(true)
  expect(components.violations.some((v) => v.startsWith('script-src-elem'))).toBe(true)
  expect(components.ran).toBe(false)

  const second = await page.context().newPage()
  await watchCsp(second)
  const composites = await injectedViolations(second, '/composites')
  expect(composites.violations.filter((v) => v.startsWith('style-src'))).toEqual([])
  expect(composites.violations.some((v) => v.startsWith('script-src-elem'))).toBe(true)
  expect(composites.ran, 'inline script did not run under APP_CSP').toBe(false)
})

// ---- [[UI458]] cycle 1: the lists page (ResourceList, StatusBadge, ConfirmDialog, ListEditor, ChoiceGroup), served with APP_CSP ----

const LIST_STATES = [
  'resource-list',
  'resource-empty',
  'resource-loading',
  'status-badges',
  'dialog-opener',
  'list-editor',
  'list-editor-refusal',
  'list-editor-readonly',
  'choice-group',
  'choice-group-readonly',
]
const DIALOG_VIEWS = ['dialog-plain', 'dialog-destructive', 'dialog-busy', 'dialog-error', 'dialog-destructive-error']
const LIST_VIEWS = [{ view: 'lists', states: LIST_STATES }, ...DIALOG_VIEWS.map((view) => ({ view, states: [view] }))]

for (const mode of MODES) {
  for (const { view, states } of LIST_VIEWS) {
    test.describe(`lists ${view} ${mode.name}`, () => {
      test.use({ colorScheme: mode.colorScheme })

      test('renders in the theme, axe finds zero violations, no CSP violation', async ({ page }) => {
        const csp = await watchCsp(page)
        const theme = mode.url.includes('theme=') ? `&${mode.url.split('?')[1]}` : ''
        await page.goto(`/lists?view=${view}${theme}`)
        await expect(page.locator('[data-gallery-state]').first()).toBeVisible()
        if (view.startsWith('dialog-')) await expect(page.getByRole('alertdialog')).toBeVisible()
        await page.screenshot({ path: join(SHOTS, `lists-${view}-${mode.name}.png`), fullPage: true })
        for (const state of states) {
          await page
            .locator(`[data-gallery-state="${state}"]`)
            .first()
            .screenshot({ path: join(SHOTS, `lists-${view}-${mode.name}-${state}.png`) })
        }
        const dark = mode.name.startsWith('dark')
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'the theme applied').toBe(
          dark ? 'rgb(10, 10, 10)' : 'rgb(255, 255, 255)',
        )
        const results = await new AxeBuilder({ page }).analyze()
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual(
          [],
        )
        expect(await csp()).toEqual([])
      })
    })
  }
}

test('lists page: every Tab stop shows a visible focus ring (outline and ring)', async ({ page }) => {
  const csp = await watchCsp(page)
  await page.goto('/lists?theme=light')
  await expect(page.locator('[data-gallery-state]').first()).toBeVisible()
  // A radio group is one Tab stop (the checked radio), so count each group once.
  const expected = await page.evaluate(
    () =>
      document.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled):not([type="radio"])').length +
      new Set([...document.querySelectorAll('input[type="radio"]')].map((r) => (r as HTMLInputElement).name)).size,
  )
  expect(expected).toBeGreaterThan(12)
  for (let i = 0; i < expected; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const s = getComputedStyle(el)
      return {
        label: el.getAttribute('aria-label') ?? el.textContent?.slice(0, 20) ?? el.id,
        outline: s.outlineStyle,
        width: parseFloat(s.outlineWidth),
        shadow: s.boxShadow,
      }
    })
    expect(info.outline, `outline on ${info.label}`).not.toBe('none')
    expect(info.width, `outline width on ${info.label}`).toBeGreaterThanOrEqual(2)
    expect(info.shadow, `ring on ${info.label}`).not.toBe('none')
  }
  expect(await csp()).toEqual([])
})

test('ConfirmDialog: Tab to the opener, Enter opens it with focus on Cancel, Escape closes it and focus is back on the opener', async ({
  page,
}) => {
  const csp = await watchCsp(page)
  await page.goto('/lists?theme=light')
  const opener = page.getByRole('button', { name: 'Open dialog-opener' })
  for (let i = 0; i < 60 && !(await opener.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab')
  expect(await opener.evaluate((el) => el === document.activeElement), 'Tab reached the opener').toBe(true)
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('alertdialog', { name: 'Disconnect ada@example.com?' })
  await expect(dialog).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe('Keep')
  await page.screenshot({ path: join(SHOTS, 'lists-dialog-keyboard-open.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect.poll(() => opener.evaluate((el) => el === document.activeElement)).toBe(true)
  expect(await csp()).toEqual([])
})

test('ListEditor: a value typed and entered by keyboard appears; the same value again is refused and the list keeps one entry', async ({
  page,
}) => {
  const csp = await watchCsp(page)
  await page.goto('/lists?theme=light')
  const state = page.locator('[data-gallery-state="list-editor"]')
  const list = state.getByRole('list', { name: 'Allowed domains' })
  await expect(list.getByRole('listitem')).toHaveCount(1)
  const input = state.getByRole('textbox', { name: 'Allowed domains' })
  await input.click()
  await page.keyboard.type('acme.test')
  await page.keyboard.press('Enter')
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await expect(list).toContainText('acme.test')
  await page.keyboard.type('acme.test')
  await page.keyboard.press('Enter')
  await expect(state.getByText('That value is already in the list.')).toBeVisible()
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await state.screenshot({ path: join(SHOTS, 'lists-list-editor-refusal.png') })
  expect(await csp()).toEqual([])
})

test('the lists page is served with APP_CSP; an injected inline <script> is a violation and did not run', async ({
  page,
}) => {
  const lists = await page.goto('/lists')
  expect(lists?.headers()['content-security-policy']).toBe(APP_CSP)
  await watchCsp(page)
  const injected = await injectedViolations(page, '/lists')
  expect(injected.violations.filter((v) => v.startsWith('style-src'))).toEqual([])
  expect(injected.violations.some((v) => v.startsWith('script-src-elem'))).toBe(true)
  expect(injected.ran, 'inline script did not run under APP_CSP').toBe(false)
})
