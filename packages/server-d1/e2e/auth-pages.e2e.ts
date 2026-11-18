// [[UI246]] PLAN, E2E: the three auth pages in a real browser against a local Worker on `better-auth`, worktree-local D1s (CRM and control from the real wrangler.jsonc).
// Prerequisite: fresh local state, both databases migrated, `.dev.vars` with AUTH_PROVIDER=better-auth, AUTH_SECRET (32+ characters) and PUBLIC_BASE_URL=http://localhost:8787,
// [[CORE294]] adds the Google leg (steps 2b, 5b, 5c): the same `.dev.vars` also carries DUMMY `AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET` (any non-empty strings, this Worker only; no request reaches Google: a Playwright route
// answers `accounts.google.com` locally, and the callback is proven in workerd, not here). Every other step runs unchanged with Google configured.
// [[UI255]] adds step 9: the same `.dev.vars` also carries `AUTH_TRUSTED_ORIGINS=http://localhost:8788`.
// `bootstrap --org E2E --auth-provider better-auth --public-base-url http://localhost:8787 --owner-email owner@e2e.test` (E2E_INVITE_URL = the URL it printed), `pnpm dev` running.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const INVITE_URL = process.env.E2E_INVITE_URL
const PKG = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = join(PKG, 'e2e-screenshots')
mkdirSync(SHOTS, { recursive: true })
const PASSWORD = 'a long enough password 123'
const REDIRECT_URI = 'http://localhost:8787/auth/callback/google'
const EXACT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

const controlRows = (sql: string): Array<Record<string, unknown>> => {
  const out = execFileSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', 'CONTROL_DB', '--local', '--json', '--command', sql],
    { cwd: PKG, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
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
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    `axe ${name} ${scheme}`,
  ).toEqual([])
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

/** Answers the navigation to Google locally and returns the URLs it was asked for. */
const fakeGoogleDoor = async () => {
  const seen: string[] = []
  await page.route('https://accounts.google.com/**', (route) => {
    seen.push(route.request().url())
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>fake google</title><h1>fake google</h1>',
    })
  })
  return seen
}
const expectGoogleDoor = (seen: string[], token?: string) => {
  expect(seen).toHaveLength(1)
  const u = new URL(seen[0]!)
  expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
  expect(u.searchParams.get('scope')).toBe('openid email profile')
  if (token) expect(seen[0]).not.toContain(token)
}

test('2b. [CORE294] the invitation link shows the Google button; clicking it goes to Google with the D7 redirect URI and scope, and the token is in no part of the URL', async () => {
  await visit(INVITE_URL!)
  const button = page.getByRole('button', { name: 'Continue with Google' })
  await expect(button).toBeVisible()
  await axeBoth(page, 'invite-google')
  const seen = await fakeGoogleDoor()
  const token = new URLSearchParams(new URL(INVITE_URL!).hash.replace(/^#/, '')).get('token')!
  await button.click()
  await page.waitForURL('https://accounts.google.com/**')
  expectGoogleDoor(seen, token)
  await page.unroute('https://accounts.google.com/**')
  expect(controlRows('select count(*) as n from auth_users')[0]!.n).toBe(0)
})

test('3. the invited address signs up (case-insensitive) and lands on the signed-in view', async () => {
  await visit(INVITE_URL!)
  await page.getByLabel('Name').fill('Owner Person')
  await page.getByLabel('Email').fill('Owner@E2E.test')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  // A finished sign-up lands on /home (UI461 D3), where the person is signed in; /sign-in then shows the signed-in view.
  await page.waitForURL('**/home')
  await visit('/sign-in')
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

test('5b. [CORE294] /sign-in shows the Google button; clicking it goes to Google with the D7 redirect URI and scope', async () => {
  await visit('/sign-in')
  const button = page.getByRole('button', { name: 'Continue with Google' })
  await expect(button).toBeVisible()
  await axeBoth(page, 'sign-in-google')
  const seen = await fakeGoogleDoor()
  await button.click()
  await page.waitForURL('https://accounts.google.com/**')
  expectGoogleDoor(seen)
  await page.unroute('https://accounts.google.com/**')
})

test('5c. [CORE294] a failed callback: invitation_required shows the refusal message; any other error one generic message, with nothing of the code or description on the page', async () => {
  await visit('/sign-in?error=invitation_required')
  await expect(page.getByRole('alert')).toContainText('This invitation cannot be used')
  await expect(page.getByRole('alert')).toBeFocused()
  await axeBoth(page, 'sign-in-google-refused')
  await visit('/sign-in?error=x&error_description=' + encodeURIComponent('<b>pwned</b>'))
  await expect(page.getByRole('alert')).toContainText('Google sign-in did not complete')
  await expect(page.getByRole('alert')).toBeFocused()
  const body = await page.locator('body').innerText()
  expect(body).not.toContain('pwned')
  expect(await page.locator('b').count()).toBe(0)
  expect(body).not.toMatch(/\bx\b/)
  await axeBoth(page, 'sign-in-google-failed')
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
  if (
    await page
      .getByText(/Too many attempts/)
      .isVisible()
      .catch(() => false)
  ) {
    console.log('NOTE: a 429 appeared on the right-password attempt; waited 11 s')
    await page.waitForTimeout(11_000)
    await attempt(PASSWORD)
  }
  // With no return_to a finished sign-in continues to /home (UI461 D3); /sign-in then shows the signed-in view.
  await page.waitForURL('**/home')
  await visit('/sign-in')
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

// [[UI255]] D3, D7, D8: a trusted app origin. The Worker's `.dev.vars` also carries `AUTH_TRUSTED_ORIGINS=http://localhost:8788` (inert for every step above). The "app" is a stub page a throwaway node listener serves on
// `http://localhost:8788/` (Playwright's `page.route` cannot: Chrome's Local Network Access check refuses a loopback fetch from a fulfilled page): it reads the session from `/auth/get-session` and signs out through `POST /auth/sign-out`, both credentialed and cross-origin. localhost ports are same-site, so the
// host-only cookie of `localhost:8787` is sent with `credentials: 'include'`.
const APP = 'http://localhost:8788/'
const STUB = `<!doctype html><meta charset="utf-8"><title>stub app</title><p id="who">loading</p><button id="out">Sign out</button>
<script>
const api = 'http://localhost:8787'
const who = document.getElementById('who')
const show = async () => {
  try {
    const r = await fetch(api + '/auth/get-session', { credentials: 'include' })
    const s = await r.json()
    who.textContent = s && s.user ? s.user.email : 'signed out'
  } catch (e) { who.textContent = 'error: ' + e }
}
document.getElementById('out').onclick = async () => {
  const r = await fetch(api + '/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })
  who.textContent = r.ok ? 'sign-out ok' : 'sign-out failed ' + r.status
  if (r.ok) await show()
}
show()
</script>`

test('9. [UI255] a trusted app origin: credentialed CORS on /auth, sign-in returns to it, sign-out works; an untrusted return_to stays on /sign-in', async () => {
  // A real listener, not `page.route`: Chrome's Local Network Access check refuses a loopback fetch from a page that Playwright fulfilled (its address space is not loopback): "Permission was denied for this request to access the `loopback` address space".
  const stub = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(STUB)
  })
  await new Promise<void>((resolve) => stub.listen(8788, 'localhost', resolve))
  try {
    await context.clearCookies()
    await visit(APP)
    await expect(page.locator('#who')).toHaveText('signed out')

    const signInAs = async (target: string) => {
      await visit(`/sign-in?return_to=${encodeURIComponent(target)}`)
      await page.getByLabel('Email').fill('owner@e2e.test')
      await page.getByLabel('Password').fill(PASSWORD)
      await page.getByRole('button', { name: 'Sign in' }).click()
    }
    await signInAs(APP)
    if (
      await page
        .getByText(/Too many attempts/)
        .isVisible()
        .catch(() => false)
    ) {
      console.log('NOTE: a 429 appeared on the app sign-in; waited 11 s')
      await page.waitForTimeout(11_000)
      await page.getByRole('button', { name: 'Sign in' }).click()
    }
    await page.waitForURL(APP)
    await expect(page.locator('#who')).toHaveText('owner@e2e.test')

    await page.locator('#out').click()
    await expect(page.locator('#who')).toHaveText('signed out')

    // An origin that is not trusted: Better Auth refuses the callbackURL, the page shows its ordinary error, stays on /sign-in, and no session exists.
    await context.clearCookies()
    await page.waitForTimeout(11_000) // Better Auth's 10 s sign-in window
    await signInAs('http://localhost:9999/')
    await expect(page.getByRole('alert')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/sign-in')
    const session = await page.evaluate(async () => (await fetch('/auth/get-session')).json())
    expect(session).toBeNull()
  } finally {
    stub.close()
  }
})

// [[UI460]] E2E (legs added after step 9, on the same fresh state, after the owner has signed up in step 3): the workspace app. Step 9 ends signed out. The app is served under APP_CSP (style-src with 'unsafe-inline', every
// other directive the auth pages'), so the exact-policy checks of steps 8 and 9 are untouched: the pages keep PAGE_CSP.
const APP_CSP_EXACT =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

test('10. [UI460] signed out: / redirects to /home, the sign-in card has no sidebar and Sign in goes to /sign-in?return_to=/home; /home/ and /app/ are 404, /app/app.js is 200', async ({
  request,
}) => {
  await context.clearCookies()
  const root = await request.get('/', { maxRedirects: 0 })
  expect(root.status()).toBe(302)
  expect(root.headers().location).toBe('/home')
  expect(root.headers()['content-security-policy']).toBe(APP_CSP_EXACT)
  await visit('/')
  expect(new URL(page.url()).pathname).toBe('/home')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Vibase' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  expect(page.url()).toMatch(/\/home$/) // nothing navigated on load
  await axeBoth(page, 'app-signed-out')
  const asset = await request.get('/app/app.js')
  expect(asset.status()).toBe(200)
  expect(asset.headers()['content-security-policy']).toBe(APP_CSP_EXACT)
  expect((await request.get('/home/')).status()).toBe(404)
  expect((await request.get('/app/')).status()).toBe(404)
  // Sign in from a page URL that carries a query: only the path comes back as return_to.
  await visit('/home?utm=x')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/sign-in?**')
  expect(new URL(page.url()).searchParams.get('return_to')).toBe('/home')
  // UI461 D3: the allow-list names the app pages, so a finished sign-in returns to /home.
  await page.waitForTimeout(11_000) // Better Auth's 10 s sign-in window
  await page.getByLabel('Email').fill('owner@e2e.test')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/home')
})

test('11. [UI460] signed in: the shell with Home current, Welcome to your CRM and Who you are, the title, the headers, no CSP violation, axe clean in both themes, one row of entries at 375 px', async ({
  request,
}) => {
  await visit('/home')
  const nav = page.getByRole('navigation', { name: 'Workspace' })
  await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to your CRM')
  const who = page.getByRole('region', { name: 'Who you are' })
  await expect(who).toContainText('owner@e2e.test')
  await expect(who).toContainText('owner')
  await expect(who).toContainText('E2E')
  await expect(page).toHaveTitle('Home · Vibase')
  const res = await page.request.get('/home')
  const h = res.headers()
  expect(h['content-security-policy']).toBe(APP_CSP_EXACT)
  expect(h['x-content-type-options']).toBe('nosniff')
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin')
  expect(h['cache-control']).toBe('no-store')
  await axeBoth(page, 'app-home')
  await page.setViewportSize({ width: 375, height: 800 })
  await visit('/home')
  await expect(nav.getByRole('link', { name: 'Home' })).toBeVisible()
  const links = await nav
    .getByRole('link')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
  expect(new Set(links).size, 'the entries are in one row').toBe(1)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'no horizontal scroll',
  ).toBe(true)
  await axeBoth(page, 'app-home-375')
  await page.setViewportSize({ width: 1280, height: 720 })
  void request
})

test('11b. [UI461] Home on the fresh instance: Get started above Who you are, Connect an agent with the login command, the MCP URL and the API-key line; Check again keeps the prompt and sends only GETs; axe clean in both themes, no horizontal scroll at 375 px', async () => {
  await visit('/home')
  const started = page.getByRole('region', { name: 'Get started' })
  await expect(started).toBeVisible()
  const who = page.getByRole('region', { name: 'Who you are' })
  const [a, b] = [await started.boundingBox(), await who.boundingBox()]
  expect(a!.y, 'Get started is above Who you are').toBeLessThan(b!.y)
  const prompt = page.getByRole('region', { name: 'Connect an agent' })
  await expect(prompt).toContainText('vibase login --server http://localhost:8787')
  const blocks = await prompt.locator('pre code').allTextContents()
  // discovery advertises mcp only when the adapter does: if it does, the URL is the Worker's /mcp.
  if (blocks.some((t) => t.includes('/mcp'))) expect(blocks).toContain('http://localhost:8787/mcp')
  expect(blocks.some((t) => t.includes('vibase login --api-key'))).toBe(true)
  await axeBoth(page, 'app-home-first-steps')
  const methods: string[] = []
  const onRequest = (r: { method(): string }) => methods.push(r.method())
  page.on('request', onRequest)
  await prompt.getByRole('button', { name: 'Check again' }).click()
  await page.waitForResponse((r) => r.url().includes('/meta/v1/agents'))
  page.off('request', onRequest)
  await expect(prompt).toBeVisible()
  expect(methods.length).toBeGreaterThan(0)
  expect(
    methods.every((m) => m === 'GET'),
    `only GET requests: ${methods.join(',')}`,
  ).toBe(true)
  await page.setViewportSize({ width: 375, height: 800 })
  await visit('/home')
  await expect(prompt).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await axeBoth(page, 'app-home-first-steps-375')
  await page.setViewportSize({ width: 1280, height: 720 })
})

test('12. [UI460] Sign out from the shell shows the sign-in card, and reloading /home stays signed out', async () => {
  await visit('/home')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(await page.evaluate(async () => (await fetch('/auth/get-session')).json())).toBeNull()
})
