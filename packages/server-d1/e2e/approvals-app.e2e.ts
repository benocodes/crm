// [[UI388]] PLAN, E2E: the approvals app (:8788) signs in, approves and signs out through the Better Auth client SDK against the Worker's /auth (:8787), in a real browser.
// Prerequisites, as for `e2e:auth-pages` (see its header) plus the app's origin: fresh worktree-local D1s (CRM and control, both migrated), `.dev.vars` with AUTH_PROVIDER=better-auth, AUTH_SECRET (32+ characters),
// PUBLIC_BASE_URL=http://localhost:8787, `AUTH_TRUSTED_ORIGINS=http://localhost:8788` and `CORS_ALLOWED_ORIGINS=http://localhost:8788` (the dummy Google pair `e2e:auth-pages` lists is fine if it is there);
// `bootstrap -- --org E2E --auth-provider better-auth --public-base-url http://localhost:8787 --owner-email owner@e2e.test` (E2E_INVITE_URL = the URL it printed); `pnpm -C packages/server-d1 dev` running on :8787.
// The app is started by playwright.approvals-app.config.ts (`pnpm -C packages/approvals-app dev`, built with APPROVALS_API_ORIGIN=http://localhost:8787, served on :8788 with the real `_headers`).
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'

const INVITE_URL = process.env.E2E_INVITE_URL
const API = 'http://localhost:8787'
const APP = 'http://localhost:8788'
const PASSWORD = 'a long enough password 123'
const stamp = Date.now()

type Res = { status: number; body: any }
const as =
  (request: APIRequestContext, token: string) =>
  async (method: 'GET' | 'POST', path: string, data?: unknown): Promise<Res> => {
    const res = await request.fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(data === undefined ? {} : { data }),
    })
    const text = await res.text()
    return { status: res.status(), body: text ? JSON.parse(text) : null }
  }

const P = { id: '', key: '' }
let taskId = ''
let requestId = ''
const violations: string[] = []
const requested: string[] = []
let context: BrowserContext
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser, request }) => {
  expect(INVITE_URL, 'E2E_INVITE_URL: the URL bootstrap printed').toBeTruthy()
  // Setup context: the owner signs up through the invitation (as `e2e:auth-pages` step 3), mints a session JWT, makes agent P (proposal-only), its API key and a task, and P proposes an update.
  const setup = await browser.newContext()
  const sp = await setup.newPage()
  await sp.goto(INVITE_URL!)
  await sp.getByLabel('Name').fill('Owner Person')
  await sp.getByLabel('Email').fill('owner@e2e.test')
  await sp.getByLabel('Password').fill(PASSWORD)
  await sp.getByRole('button', { name: 'Create account' }).click()
  await sp.waitForURL('**/connect')
  const token = await sp.evaluate(async () => ((await (await fetch('/auth/token')).json()) as { token: string }).token)
  await setup.close()
  const owner = as(request, token)
  const agent = await owner('POST', '/meta/v1/agents', {
    name: `ui388-p-${stamp}`,
    scopes: ['tasks:read', 'tasks:request_approval', 'action_requests:read'],
  })
  expect(agent.status, JSON.stringify(agent.body)).toBe(201)
  P.id = agent.body.id
  const key = await owner('POST', '/meta/v1/api-keys', { agent_id: P.id })
  expect(key.status, JSON.stringify(key.body)).toBe(201)
  P.key = key.body.key
  const task = await owner('POST', '/api/v1/tasks', { title: `T ${stamp}` })
  expect(task.status, JSON.stringify(task.body)).toBe(201)
  taskId = task.body.id
  const proposal = await as(request, P.key)('POST', '/api/v1/action-requests', {
    operation: 'tasks.update',
    arguments: { id: taskId, title: 'retitled by approval' },
    reason: 'the title is wrong',
  })
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201)
  requestId = proposal.body.id
  // The test context: fresh, signed out.
  context = await browser.newContext()
  page = await context.newPage()
  page.on('console', (m) => /content security policy/i.test(m.text()) && violations.push(m.text()))
  page.on('request', (r) => requested.push(r.url()))
})
test.afterAll(async () => {
  expect(violations, 'no CSP violation on the app page').toEqual([])
  await context?.close()
})

test('1. the app opens signed out with a Sign in button; the Better Auth chunk loaded, no Clerk host was asked', async () => {
  await page.goto(`${APP}/`)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(requested.some((u) => u.startsWith(`${APP}/chunks/better-auth-`))).toBe(true)
  expect(requested.filter((u) => /clerk/i.test(new URL(u).hostname))).toEqual([])
  expect(requested.some((u) => u.includes('/chunks/clerk-'))).toBe(false)
})

test('2. Sign in goes to the vault /sign-in with return_to the app', async () => {
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/localhost:8787\/sign-in/)
  expect(page.url()).toBe(`${API}/sign-in?return_to=http%3A%2F%2Flocalhost%3A8788%2F`)
})

test('3. signing in with the owner password returns to the app, signed in, with the pending request', async () => {
  await page.getByLabel('Email').fill('owner@e2e.test')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(`${APP}/`)
  await expect(page.getByText('owner@e2e.test')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Update task' })).toBeVisible()
  await expect(page.getByText('the title is wrong')).toBeVisible()
})

test('4. approving leaves Pending; read back as P it is no longer pending and the decision is the owner', async ({
  request,
}) => {
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('Nothing waiting for you.')).toBeVisible()
  const got = await as(request, P.key)('GET', `/api/v1/action-requests/${requestId}`)
  expect(got.status, JSON.stringify(got.body)).toBe(200)
  expect(got.body.status).not.toBe('pending')
  expect(got.body.decided_by).toBeTruthy()
  expect(got.body.decided_by).not.toBe(P.id)
})

test('5. Sign out shows the signed-out view; the session is gone', async () => {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  const session = await page.evaluate(
    async () => await (await fetch('http://localhost:8787/auth/get-session', { credentials: 'include' })).json(),
  )
  expect(session).toBeNull()
})

test('6. a reload is still signed out', async () => {
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByText('owner@e2e.test')).toHaveCount(0)
})
