// [[UI469]] E2E: the Gmail connect flow returns to the instance's own /app/accounts, and Home prompts a person with no mailbox, in a real browser against a local Worker on `better-auth`
// (this worktree's local D1s from the real wrangler.jsonc). No request leaves localhost: a Playwright route answers `accounts.google.com`, so the callback's SUCCESS return (a real Google token exchange) is not run here;
// its redirect is proven in-process (api connect.integration.d1 and server-d1 compose-connect-return tests). The callback's REFUSAL returns run for real.
// Prerequisite: FRESH local state (`rm -rf .wrangler/state` in packages/server-d1; do not share it with another E2E: each consumes the owner invitation), and `.dev.vars` holding `e2e:auth-pages`' set
// (AUTH_PROVIDER=better-auth, AUTH_SECRET 32+ chars, PUBLIC_BASE_URL=http://localhost:8787, dummy AUTH_GOOGLE_CLIENT_ID / AUTH_GOOGLE_CLIENT_SECRET, AUTH_TRUSTED_ORIGINS=http://localhost:8788) PLUS the Gmail core four:
// GOOGLE_CLIENT_ID=e2e.apps.googleusercontent.com, GOOGLE_CLIENT_SECRET=<any>, OAUTH_STATE_SECRET=<random>, CREDENTIALS_KEY=<base64 of 32 random bytes>; NO CONNECT_RETURN_URL and no push variables.
//   pnpm -C packages/server-d1 bootstrap -- --org E2E --auth-provider better-auth --public-base-url http://localhost:8787 --owner-email owner@e2e.test   (E2E_INVITE_URL = the URL it printed)
//   pnpm -C packages/server-d1 dev     (wait for its build, then:)
//   E2E_INVITE_URL=<url> pnpm -C packages/server-d1 e2e:accounts-connect
// The page must be opened at `http://localhost:8787` exactly (not 127.0.0.1): Better Auth's origin check trusts PUBLIC_BASE_URL only. Stop the dev server afterwards.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const INVITE_URL = process.env.E2E_INVITE_URL
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8787'
const PKG = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = join(PKG, 'e2e-screenshots')
mkdirSync(SHOTS, { recursive: true })
const PASSWORD = 'a long enough password 123'
const CLIENT_ID = 'e2e.apps.googleusercontent.com'

const violations: string[] = []
let context: BrowserContext
let page: Page
test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()
  page.on('console', (m) => /content security policy/i.test(m.text()) && violations.push(m.text()))
})
test.afterAll(async () => {
  expect(violations, 'no CSP violation in the console').toEqual([])
  await context.close()
})

const axeAndShot = async (name: string, scheme: 'light' | 'dark') => {
  await page.emulateMedia({ colorScheme: scheme })
  await page.screenshot({ path: join(SHOTS, `${name}--${scheme}.png`), fullPage: true })
  const results = await new AxeBuilder({ page }).analyze()
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    `axe ${name} ${scheme}`,
  ).toEqual([])
}
const axeBoth = async (name: string) => {
  await axeAndShot(name, 'light')
  await axeAndShot(name, 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
}
const visit = async (url: string) => {
  await page.goto('about:blank')
  await page.goto(url)
}
const noScroll = async () =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

test('1. the owner signs up and lands on /app/home: Get started shows Connect your email above Connect an agent; Connect Gmail opens /app/accounts', async () => {
  expect(INVITE_URL, 'E2E_INVITE_URL').toBeTruthy()
  await visit(INVITE_URL!)
  await page.getByLabel('Name').fill('Owner Person')
  await page.getByLabel('Email').fill('owner@e2e.test')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL((u) => u.pathname === '/app/home')
  const started = page.getByRole('region', { name: 'Get started' })
  const email = started.getByRole('region', { name: 'Connect your email' })
  const agent = started.getByRole('region', { name: 'Connect an agent' })
  await expect(email).toContainText('Connect your Gmail so your conversations land in your CRM.')
  await expect(agent).toBeVisible()
  const order = await started.evaluate((s) =>
    [...s.querySelectorAll('section[aria-label], section')].map(
      (e) => e.getAttribute('aria-label') ?? e.querySelector('h2,h3')?.textContent,
    ),
  )
  expect(order.indexOf('Connect your email')).toBeLessThan(order.indexOf('Connect an agent'))
  await axeBoth('home-both-prompts')
  await page.setViewportSize({ width: 375, height: 800 })
  await visit('/app/home')
  await expect(email).toBeVisible()
  await noScroll()
  await page.setViewportSize({ width: 1280, height: 720 })
  await visit('/app/home')
  const link = email.getByRole('link', { name: 'Connect Gmail' })
  await expect(link).toHaveAttribute('href', '/app/accounts')
  await link.click()
  await page.waitForURL((u) => u.pathname === '/app/accounts')
  await expect(page.getByRole('region', { name: 'Your mailboxes' })).toContainText('No mailbox connected yet')
})

let state = ''
test('2. Connect Gmail navigates to Google (intercepted) with the configured client, the instance callback and a state', async () => {
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Google stub</title><p>stub</p>',
    }),
  )
  await page.getByRole('region', { name: 'Your mailboxes' }).getByRole('button', { name: 'Connect Gmail' }).click()
  await page.waitForURL('https://accounts.google.com/**')
  const u = new URL(page.url())
  expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(u.searchParams.get('client_id')).toBe(CLIENT_ID)
  expect(u.searchParams.get('redirect_uri')).toBe(`${BASE}/oauth/callback/google`)
  state = u.searchParams.get('state') ?? ''
  expect(state.length).toBeGreaterThan(10)
  await page.unroute('https://accounts.google.com/**')
})

// [[CORE572]] P5, D8. The premise: the session cookie is sent on Google's redirect back, a cross-site top-level GET. Google is stubbed by a route that 302s straight to the callback with `error=access_denied`.
// `localhost` stands in for a real host here; the HTTPS `__Secure-` cookie prefix is covered by the Set-Cookie pin in compose-connect-session.test.ts, not by this run.
test('A. the owner is bounced from Google to the callback cross-site: the session cookie is sent, so the callback passes the session step (consent_denied), not session_mismatch', async () => {
  await page.route('https://accounts.google.com/**', (route) => {
    const st = new URL(route.request().url()).searchParams.get('state') ?? ''
    return route.fulfill({
      status: 302,
      headers: { location: `${BASE}/oauth/callback/google?error=access_denied&state=${encodeURIComponent(st)}` },
    })
  })
  await visit('/app/accounts')
  await page.getByRole('region', { name: 'Your mailboxes' }).getByRole('button', { name: 'Connect Gmail' }).click()
  await page.waitForURL((u) => u.pathname === '/app/accounts' && u.search === '')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('consent_denied')
  await expect(alert).not.toContainText('session_mismatch')
  await page.unroute('https://accounts.google.com/**')
})

test('B. a browser with no session opening the same callback is refused: session_mismatch, and no mailbox appears for the owner', async () => {
  const stranger = await context.browser()!.newContext()
  try {
    const res = await stranger.request.get(
      `${BASE}/oauth/callback/google?error=access_denied&state=${encodeURIComponent(state)}`,
      { maxRedirects: 0 },
    )
    expect(res.status()).toBe(302)
    expect(res.headers()['location']).toBe(`${BASE}/app/accounts?error=session_mismatch`)
  } finally {
    await stranger.close()
  }
  await visit('/app/accounts')
  await expect(page.getByRole('region', { name: 'Your mailboxes' })).toContainText('No mailbox connected yet')
  await visit(`${BASE}/app/accounts?error=session_mismatch`)
  await expect(page.getByRole('alert')).toContainText(
    'Sign in to this workspace in this browser as the person who started the connection, then start again.',
  )
})

test('3. Google cancel (simulated): the callback returns to /app/accounts with consent_denied, shown once and removed from the address bar', async () => {
  const res = await page.request.get(
    `${BASE}/oauth/callback/google?error=access_denied&state=${encodeURIComponent(state)}`,
    {
      maxRedirects: 0,
    },
  )
  expect(res.status()).toBe(302)
  expect(res.headers()['location']).toBe(`${BASE}/app/accounts?error=consent_denied`)
  expect(res.headers()['cache-control']).toBe('no-store')
  expect(res.headers()['referrer-policy']).toBe('no-referrer')
  await visit(`${BASE}/oauth/callback/google?error=access_denied&state=${encodeURIComponent(state)}`)
  await page.waitForURL((u) => u.pathname === '/app/accounts')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('The connection was cancelled at Google. Nothing was connected.')
  await expect(alert).toContainText('consent_denied')
  await expect(page).toHaveURL((u) => u.pathname === '/app/accounts' && u.search === '')
  await axeBoth('accounts-return-error')
  await page.setViewportSize({ width: 375, height: 800 })
  await noScroll()
  await page.setViewportSize({ width: 1280, height: 720 })
})

test('4. the callback with no state returns to /app/accounts?error=state_invalid', async () => {
  const res = await page.request.get(`${BASE}/oauth/callback/google`, { maxRedirects: 0 })
  expect(res.status()).toBe(302)
  expect(res.headers()['location']).toBe(`${BASE}/app/accounts?error=state_invalid`)
})

test('5. with a mailbox the owner owns, Connect your email is gone from Home and Connect an agent remains', async () => {
  execFileSync('pnpm', ['exec', 'tsx', 'e2e/seed-connection.ts', 'mailbox@e2e.test'], {
    cwd: PKG,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await visit('/app/home')
  const started = page.getByRole('region', { name: 'Get started' })
  await expect(started.getByRole('region', { name: 'Connect an agent' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Connect your email' })).toHaveCount(0)
  await axeBoth('home-agent-only')
})
