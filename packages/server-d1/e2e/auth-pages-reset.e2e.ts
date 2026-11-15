// [[CORE304]] E2E: self-service password reset by email, in a real browser against a local Worker on `better-auth` with email ON (worktree-local D1s from the real wrangler.jsonc).
// The email capture is a recording `EMAIL` binding composed for the E2E (`src/test/entry-email.ts`, never deployed): the real Worker module with `env.EMAIL` replaced by a recorder, read back at `/__emails`.
// (wrangler's own local `send_email` simulation was not relied on: D8 asks for a fake binding, and a recorder gives the spec the message objects directly.)
// Prerequisite: FRESH local state (do not share it with `e2e:auth-pages` or `e2e:oauth-pages`: each consumes the owner invitation), both databases migrated, `.dev.vars` with AUTH_PROVIDER=better-auth, AUTH_SECRET (32+ chars),
// PUBLIC_BASE_URL=https://localhost:8787 and AUTH_EMAIL_FROM=noreply@vibase.test,
//   `bootstrap --org E2E --auth-provider better-auth --public-base-url https://localhost:8787 --owner-email owner@e2e.test` (E2E_INVITE_URL = the URL it printed), and the Worker running:
//   pnpm -C packages/server-d1 build && pnpm -C packages/server-d1 exec wrangler dev src/test/entry-email.ts --local --local-protocol https --port 8787 2>&1 | tee /tmp/reset-worker.log
// E2E_WORKER_LOG=/tmp/reset-worker.log makes the last step check the Worker's log for the address and the token. Run: E2E_INVITE_URL=<url> pnpm -C packages/server-d1 e2e:auth-pages-reset
// Better Auth limits sign-in per IP (3 per 10 s) and local requests share one bucket (no cf-connecting-ip): the sign-ins below wait the window out where they follow another.
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8787'
const INVITE_URL = process.env.E2E_INVITE_URL
const WORKER_LOG = process.env.E2E_WORKER_LOG
const PKG = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = join(PKG, 'e2e-screenshots')
mkdirSync(SHOTS, { recursive: true })
const OWNER_PASSWORD = 'an owner password 123'
const OLD = 'a long enough password 123'
const NEW = 'a brand new password 456'
const MEMBER = 'member@e2e.test'
const CONFIRMATION = 'If an account exists for that address, a reset link is on its way.'

const violations: string[] = []
let owner: { context: BrowserContext; page: Page }
let anon: { context: BrowserContext; page: Page }
let other: { context: BrowserContext; page: Page } // the member's second, already signed-in browser
test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ browser }) => {
  const open = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    page.on('console', (m) => /content security policy/i.test(m.text()) && violations.push(m.text()))
    return { context, page }
  }
  owner = await open()
  anon = await open()
  other = await open()
})
test.afterAll(async () => {
  expect(violations, 'no CSP violation in the console').toEqual([])
  for (const c of [owner, anon, other]) await c.context.close()
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
/** A fresh page load (a link opened from an email is always a new load). */
const visit = async (page: Page, url: string) => {
  await page.goto('about:blank')
  await page.goto(url)
}
const recorded = async (request: APIRequestContext) =>
  (await (await request.get('/__emails')).json()) as Array<Record<string, any>>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Signs in through the form; a 429 (the 10 s sign-in window) is waited out once and said so. */
const signInForm = async (page: Page, email: string, password: string) => {
  await visit(page, '/sign-in')
  const attempt = async () => {
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await attempt()
  if (
    await page
      .getByText(/Too many attempts/)
      .isVisible()
      .catch(() => false)
  ) {
    console.log('NOTE: a 429 appeared on a sign-in; waited 11 s')
    await page.waitForTimeout(11_000)
    await attempt()
  }
}

test('1. discovery says self_service_reset: true, and /sign-in offers "Forgot password?" instead of the ask-an-owner line', async ({
  request,
}) => {
  const doc = (await (await request.get('/.well-known/vibase')).json()) as any
  expect(doc.auth.self_service_reset).toBe(true)
  await visit(anon.page, '/sign-in')
  await expect(anon.page.getByRole('button', { name: 'Forgot password?' })).toBeVisible()
  await expect(anon.page.getByText(/ask an owner/i)).toHaveCount(0)
})

test('2. setup: the owner signs up from the bootstrap URL and invites the member; the member signs up through the link; a second browser signs in as the member', async ({
  request,
}) => {
  expect(INVITE_URL, 'E2E_INVITE_URL: the URL bootstrap printed').toBeTruthy()
  expect(await recorded(request)).toEqual([])
  await visit(owner.page, INVITE_URL!)
  await owner.page.getByLabel('Name').fill('Owner Person')
  await owner.page.getByLabel('Email').fill('owner@e2e.test')
  await owner.page.getByLabel('Password').fill(OWNER_PASSWORD)
  await owner.page.getByRole('button', { name: 'Create account' }).click()
  await owner.page.waitForURL('**/sign-in')
  await expect(owner.page.getByText('Signed in as owner@e2e.test')).toBeVisible()
  const invited = await owner.page.evaluate(async (email) => {
    const t = (await (await fetch('/auth/token')).json()) as { token: string }
    const res = await fetch('/meta/v1/invitations', {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, role: 'member', delivery: 'link' }),
    })
    return { status: res.status, body: (await res.json()) as { url?: string } }
  }, MEMBER)
  expect(invited.status).toBe(201)
  await visit(anon.page, invited.body.url!)
  await anon.page.getByLabel('Name').fill('Member Person')
  await anon.page.getByLabel('Email').fill(MEMBER)
  await anon.page.getByLabel('Password').fill(OLD)
  await anon.page.getByRole('button', { name: 'Create account' }).click()
  await anon.page.waitForURL('**/sign-in')
  await expect(anon.page.getByText(`Signed in as ${MEMBER}`)).toBeVisible()
  // sign the first browser out so it is the anonymous one asking for a reset; the second browser keeps a session
  await anon.page.getByRole('button', { name: 'Sign out' }).click()
  await expect(anon.page.getByLabel('Email')).toBeVisible()
  await signInForm(other.page, MEMBER, OLD)
  await expect(other.page.getByText(`Signed in as ${MEMBER}`)).toBeVisible()
})

test('3. a known address: Forgot password? reveals the form (axe clean), the confirmation replaces it, and exactly one message is captured', async ({
  request,
}) => {
  await visit(anon.page, '/sign-in')
  await anon.page.getByRole('button', { name: 'Forgot password?' }).click()
  const email = anon.page.getByLabel('Email')
  await expect(email).toBeVisible()
  expect(await email.getAttribute('autocomplete')).toBe('email')
  await axeBoth(anon.page, 'reset-request-form')
  await email.fill(MEMBER)
  await anon.page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(anon.page.getByText(CONFIRMATION)).toBeVisible()
  await expect(anon.page.getByLabel('Email')).toHaveCount(0)
  await axeBoth(anon.page, 'reset-request-confirmation')
  await expect.poll(async () => (await recorded(request)).length, { timeout: 15_000 }).toBe(1)
  const m = (await recorded(request))[0]!
  expect(m.to).toBe(MEMBER)
  expect(m.subject).toBe('Reset your Vibase password at localhost:8787')
})

test('4. an unknown address gets the same confirmation and no new message', async ({ request }) => {
  await visit(anon.page, '/sign-in')
  await anon.page.getByRole('button', { name: 'Forgot password?' }).click()
  await anon.page.getByLabel('Email').fill('nobody@e2e.test')
  await anon.page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(anon.page.getByText(CONFIRMATION)).toBeVisible()
  await sleep(2000)
  expect(await recorded(request)).toHaveLength(1)
})

test('5. the captured link opens /reset-password; the new password signs in and the old one is refused', async ({
  request,
}) => {
  const [m] = await recorded(request)
  const link = /https?:\/\/\S+#token=\S+/.exec(m!.text)![0]!
  expect(link.startsWith(`${BASE}/reset-password#token=`)).toBe(true)
  await visit(anon.page, link)
  expect(new URL(anon.page.url()).hash).toBe('')
  await anon.page.getByLabel('New password', { exact: true }).fill(NEW)
  await anon.page.getByLabel('Confirm new password').fill(NEW)
  await anon.page.getByRole('button', { name: 'Set new password' }).click()
  await anon.page.waitForURL('**/sign-in?notice=password-reset')
  await signInForm(anon.page, MEMBER, NEW)
  await expect(anon.page.getByText(`Signed in as ${MEMBER}`)).toBeVisible()
  await sleep(11_000)
  const old = await request.post('/auth/sign-in/email', {
    data: { email: MEMBER, password: OLD },
    headers: { origin: BASE },
  })
  expect(old.status()).toBe(401)
})

test("6. the member's other browser is signed out by the reset", async () => {
  const session = await other.page.evaluate(async () => (await fetch('/auth/get-session')).json())
  expect(session).toBeNull()
  const me = await other.page.evaluate(async () => (await fetch('/auth/token')).status)
  expect(me).toBeGreaterThanOrEqual(400)
})

test('7. the Worker log holds neither the address nor the token (when E2E_WORKER_LOG names it)', async ({
  request,
}) => {
  test.skip(!WORKER_LOG, 'E2E_WORKER_LOG not set: the Worker log was not captured')
  const [m] = await recorded(request)
  const token = new URL(/https?:\/\/\S+#token=\S+/.exec(m!.text)![0]!).hash.replace('#token=', '')
  const log = readFileSync(WORKER_LOG!, 'utf8')
  expect(log).not.toContain(MEMBER)
  expect(log).not.toContain(token)
})
