// [[UI246]] PLAN, E2E: the three auth pages in a real browser against a local Worker on `better-auth`, worktree-local D1s (CRM and control from the real wrangler.jsonc).
// Prerequisite: fresh local state, both databases migrated, `.dev.vars` with AUTH_PROVIDER=better-auth, AUTH_SECRET (32+ characters) and PUBLIC_BASE_URL=http://localhost:8787,
// `bootstrap --org E2E --auth-provider better-auth --public-base-url http://localhost:8787 --owner-email owner@e2e.test` (E2E_INVITE_URL = the URL it printed), `pnpm dev` running.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const INVITE_URL = process.env.E2E_INVITE_URL
const PKG = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = join(PKG, 'e2e-screenshots')
mkdirSync(SHOTS, { recursive: true })
const PASSWORD = 'a long enough password 123'
const EXACT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

const controlRows = (sql: string): Array<Record<string, unknown>> => {
  const out = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'CONTROL_DB', '--local', '--json', '--command', sql], { cwd: PKG, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const parsed = JSON.parse(out.slice(out.indexOf('['))) as Array<{ results: Array<Record<string, unknown>> }>
  return parsed[0]!.results
}

// One browser context for the whole run: the session cookie made by the sign-up in step 3 is what steps 4 to 6 use (Playwright's per-test `page` would start each step signed out).
const violations: string[] = []
let context: BrowserContext
let page: Page
test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()
  page.on('console', (m) => /content security policy/i.test(m.text()) && violations.push(m.text()))
})
test.afterAll(async () => {
  expect(violations, 'no CSP violation in the console').toEqual([])
  await context.close()
})

const axeAndShot = async (page: Page, name: string, scheme: 'light' | 'dark') => {
  await page.emulateMedia({ colorScheme: scheme })
  await page.screenshot({ path: join(SHOTS, `${name}--${scheme}.png`), fullPage: true })
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe ${name} ${scheme}`).toEqual([])
}
const axeBoth = async (page: Page, name: string) => {
  await axeAndShot(page, name, 'light')
  await axeAndShot(page, name, 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
}

test.describe.configure({ mode: 'serial' })

/** A fresh page load of `url`: a navigation that only changes the fragment of the current page would not reload it (a link opened from an email is always a new load). */
const visit = async (url: string) => {
  await page.goto('about:blank')
  await page.goto(url)
}

test('1. /invite with no fragment: an explanation and no form', async () => {
  await visit('/invite')
  await expect(page.getByText(/needs the invitation link/)).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveCount(0)
  await axeBoth(page, 'invite-no-token')
})

test('2. the owner URL: the fragment leaves the address; another email is refused in a focused alert; nothing is written', async () => {
  expect(INVITE_URL, 'E2E_INVITE_URL: the URL bootstrap printed').toBeTruthy()
  await visit(INVITE_URL!)
  await expect(page.getByLabel('Email')).toBeVisible()
  const url = new URL(page.url())
  expect(url.pathname).toBe('/invite')
  expect(url.hash).toBe('')
  await page.getByLabel('Name').fill('Other Person')
  await page.getByLabel('Email').fill('other@e2e.test')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('This invitation cannot be used')
  await expect(alert).toBeFocused()
  await axeBoth(page, 'invite-form-error')
  expect(controlRows('select count(*) as n from auth_users')[0]!.n).toBe(0)
})

test('3. the invited address signs up (case-insensitive) and lands on the signed-in view', async () => {
  await visit(INVITE_URL!)
  await page.getByLabel('Name').fill('Owner Person')
  await page.getByLabel('Email').fill('Owner@E2E.test')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL('**/sign-in')
  await expect(page.getByText('Signed in as owner@e2e.test')).toBeVisible()
  await axeBoth(page, 'sign-in-signed-in')
})

test('4. the browser session mints a token the API accepts: the owner, role owner', async () => {
  await visit('/sign-in')
  await expect(page.getByText('Signed in as owner@e2e.test')).toBeVisible()
  const me = await page.evaluate(async () => {
    const t = (await (await fetch('/auth/token')).json()) as { token: string }
    const res = await fetch('/meta/v1/me', { headers: { authorization: `Bearer ${t.token}` } })
    return { jwt: t.token.split('.').length, status: res.status, body: await res.json() }
  })
  expect(me.jwt).toBe(3)
  expect(me.status).toBe(200)
  expect(JSON.stringify(me.body)).toContain('owner@e2e.test')
  expect(JSON.stringify(me.body)).toMatch(/"role":"owner"/)
})

test('5. sign out returns to the form and the session is gone', async () => {
  await visit('/sign-in')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByLabel('Email')).toBeVisible()
  expect(await page.evaluate(async () => (await fetch('/auth/get-session')).json())).toBeNull()
  await axeBoth(page, 'sign-in-form')
})

test('6. a wrong password is the one message; the right one signs in', async () => {
  await visit('/sign-in')
  const attempt = async (password: string) => {
    await page.getByLabel('Email').fill('owner@e2e.test')
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await attempt('not the right password')
  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible()
  let text = await alert.textContent()
  if (/Too many attempts/.test(text ?? '')) {
    // Better Auth's 10 s sign-in window: wait it out and say so (RESULT.md reports the 429).
    console.log('NOTE: a 429 appeared on the wrong-password attempt; waited 11 s')
    await page.waitForTimeout(11_000)
    await attempt('not the right password')
    text = await page.getByRole('alert').textContent()
  }
  expect(text).toBe('The email or password is wrong.')
  await expect(page.getByRole('alert')).toBeFocused()
  await attempt(PASSWORD)
  if (await page.getByText(/Too many attempts/).isVisible().catch(() => false)) {
    console.log('NOTE: a 429 appeared on the right-password attempt; waited 11 s')
    await page.waitForTimeout(11_000)
    await attempt(PASSWORD)
  }
  await expect(page.getByText('Signed in as owner@e2e.test')).toBeVisible()
})

test('7. /reset-password: no fragment explains; a bogus token with matching passwords is the invalid-link message', async () => {
  await visit('/reset-password')
  await expect(page.getByText(/needs the reset link/)).toBeVisible()
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0)
  await visit('/reset-password#token=bogus')
  expect(new URL(page.url()).hash).toBe('')
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm new password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Set new password' }).click()
  await expect(page.getByRole('alert')).toContainText('invalid, expired or already used')
  await axeBoth(page, 'reset-form-error')
})

test('8. every page and the bundle carry the exact headers', async ({ request }) => {
  for (const path of ['/sign-in', '/invite', '/reset-password', '/ui/app.js', '/ui/ui.css']) {
    const res = await request.get(path)
    expect(res.status(), path).toBe(200)
    const h = res.headers()
    expect(h['content-security-policy'], path).toBe(EXACT_CSP)
    expect(h['x-content-type-options'], path).toBe('nosniff')
    expect(h['referrer-policy'], path).toBe('strict-origin-when-cross-origin')
    if (path === '/ui/app.js' || path === '/ui/ui.css') continue
    expect(h['cache-control'], path).toBe('no-store')
  }
  expect((await request.get('/sign-in/', { maxRedirects: 0 })).status()).toBe(404)
})
