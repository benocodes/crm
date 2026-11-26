// [[DX637]] PLAN, E2E (D12): the browser sign-in example (:5180) signs in, lists, reloads, refreshes, signs out and is refused after its client is deleted, in a real browser,
// against the local Worker (:8787). Nothing remote.
// Prerequisites, as for `e2e:approvals-app` (see its header): fresh worktree-local D1s (CRM and control, both migrated), `.dev.vars` with AUTH_PROVIDER=better-auth, AUTH_SECRET (32+ characters),
// PUBLIC_BASE_URL=http://localhost:8787 and `CORS_ALLOWED_ORIGINS=http://localhost:5180` (and NO :5180 in AUTH_TRUSTED_ORIGINS: the app must not need it);
// `bootstrap -- --org E2E --auth-provider better-auth --public-base-url http://localhost:8787 --owner-email owner@e2e.test` (E2E_INVITE_URL = the URL it printed);
// `pnpm -C packages/server-d1 dev` running on :8787. Nothing may listen on :5180: this script starts the example there, once the client exists (the order trap).
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'

const INVITE_URL = process.env.E2E_INVITE_URL
const API = 'http://localhost:8787'
const APP = 'http://localhost:5180'
const PASSWORD = 'a long enough password 123'
const EXAMPLE_DIR = fileURLToPath(new URL('../../browser-app-example', import.meta.url))
const stamp = Date.now()
const CONTACT = `Browser Contact ${stamp}`

interface Entry {
  url: string
  method: string
  postData: string | null
  status: number
  reqHeaders: Record<string, string>
  resHeaders: Record<string, string>
}
const entries: Entry[] = []
const consoleErrors: string[] = []
const navigations: string[] = []
let context: BrowserContext
let setupContext: BrowserContext
let setupPage: Page
let page: Page
let clientId = ''
let example: ChildProcess | undefined
let mark = 0

const settle = () => new Promise((r) => setTimeout(r, 400))
const isApi = (e: Entry) =>
  e.method !== 'OPTIONS' && (e.url.startsWith(`${API}/api/`) || e.url.startsWith(`${API}/meta/`))
const tokenCalls = (grant: string, from = 0) =>
  entries
    .slice(from)
    .filter(
      (e) =>
        e.method === 'POST' &&
        e.url === `${API}/auth/oauth2/token` &&
        (e.postData ?? '').includes(`grant_type=${grant}`),
    )
const sinceMark = () => entries.slice(mark)
const ownerToken = async () =>
  setupPage.evaluate(async () => ((await (await fetch('/auth/token')).json()) as { token: string }).token)
const owner = async (request: APIRequestContext, method: 'GET' | 'POST' | 'DELETE', path: string, data?: unknown) => {
  const res = await request.fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await ownerToken()}` },
    ...(data === undefined ? {} : { data }),
  })
  const text = await res.text()
  return { status: res.status(), body: text ? JSON.parse(text) : null }
}
const run = (cmd: string, args: string[], env: Record<string, string>) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: EXAMPLE_DIR, env: { ...process.env, ...env }, stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))))
  })

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser, request }) => {
  expect(INVITE_URL, 'E2E_INVITE_URL: the URL bootstrap printed').toBeTruthy()
  // Setup context: the owner signs up through the invitation, creates a contact and registers the client. It stays open: the owner deletes the client in step 6.
  setupContext = await browser.newContext()
  setupPage = await setupContext.newPage()
  await setupPage.goto(INVITE_URL!)
  await setupPage.getByLabel('Name').fill('Owner Person')
  await setupPage.getByLabel('Email').fill('owner@e2e.test')
  await setupPage.getByLabel('Password').fill(PASSWORD)
  await setupPage.getByRole('button', { name: 'Create account' }).click()
  await setupPage.waitForURL((u) => u.pathname === '/app/home')
  const contact = await owner(request, 'POST', '/api/v1/contacts', { name: CONTACT })
  expect(contact.status, JSON.stringify(contact.body)).toBe(201)
  const client = await owner(request, 'POST', '/meta/v1/oauth-clients', {
    name: `browser-app-example ${stamp}`,
    redirect_uris: [`${APP}/callback`],
  })
  expect(client.status, JSON.stringify(client.body)).toBe(201)
  expect(client.body.warnings ?? [], 'no origin warning: CORS_ALLOWED_ORIGINS lists the example').toEqual([])
  clientId = client.body.client_id
  expect(clientId).toBeTruthy()
  // Build and serve the example, now that the client exists.
  const occupied = await fetch(`${APP}/`).then(
    () => true,
    () => false,
  )
  expect(occupied, 'nothing may listen on :5180 before this script starts the example').toBe(false)
  await run('pnpm', ['build'], { VIBASE_URL: API, VIBASE_CLIENT_ID: clientId })
  example = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', '5180', '--inspector-port', '9231'], {
    cwd: EXAMPLE_DIR,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    stdio: 'inherit',
  })
  await expect
    .poll(
      () =>
        fetch(`${APP}/`).then(
          (r) => r.status,
          () => 0,
        ),
      { timeout: 60_000 },
    )
    .toBe(200)
  // The test context: fresh, signed out.
  context = await browser.newContext()
  page = await context.newPage()
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('framenavigated', (f) => f === page.mainFrame() && navigations.push(f.url()))
  page.on('response', async (res) => {
    const req = res.request()
    entries.push({
      url: req.url(),
      method: req.method(),
      postData: req.postData(),
      status: res.status(),
      reqHeaders: await req.allHeaders(),
      resHeaders: await res.allHeaders(),
    })
  })
})
test.afterAll(async () => {
  await context?.close()
  await setupContext?.close()
  if (example?.pid) {
    example.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
  }
})

const expectCredentialFree = (e: Entry) => {
  expect(e.reqHeaders.cookie, `${e.method} ${e.url} carried a cookie`).toBeUndefined()
  expect(e.resHeaders['access-control-allow-origin']).toBe(APP)
  expect(e.resHeaders['access-control-allow-credentials']).toBeUndefined()
}

test('1. "Sign in" goes to the deployment, signs in the owner with no consent screen, and the app lists the contact as a user principal', async () => {
  await page.goto(`${APP}/`)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/localhost:8787\/app\/sign-in/)
  await page.getByLabel('Email').fill('owner@e2e.test')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((u) => u.origin === APP && !u.searchParams.has('code'))
  await expect(page.getByText(CONTACT)).toBeVisible()
  await expect(page.getByText('principal: user')).toBeVisible()
  await expect(page.getByText('owner@e2e.test')).toBeVisible()
  expect(
    navigations.filter((u) => /consent/i.test(u)),
    'no consent page',
  ).toEqual([])
})

test('2. the token request carried no cookie and was answered for the app origin without credentials; every API call is a bearer call with no cookie; the callback URL holds no code', async () => {
  await settle()
  const [code] = tokenCalls('authorization_code')
  expect(code, 'an authorization_code token request').toBeTruthy()
  expectCredentialFree(code!)
  const calls = entries.filter(isApi)
  expect(calls.length).toBeGreaterThanOrEqual(2)
  for (const c of calls) {
    expect(c.reqHeaders.authorization).toMatch(/^Bearer /)
    expect(c.reqHeaders.cookie, c.url).toBeUndefined()
  }
  expect(page.url()).not.toContain('code=')
  console.log(
    'EVIDENCE token request (authorization_code):',
    JSON.stringify({
      status: code!.status,
      request: { cookie: code!.reqHeaders.cookie ?? null },
      response: {
        'access-control-allow-origin': code!.resHeaders['access-control-allow-origin'],
        'access-control-allow-credentials': code!.resHeaders['access-control-allow-credentials'] ?? null,
      },
    }),
  )
})

test('3. a reload is still signed in and asks authorize for nothing', async () => {
  mark = entries.length
  await page.reload()
  await expect(page.getByText(CONTACT)).toBeVisible()
  await settle()
  expect(sinceMark().filter((e) => e.url.includes('/auth/oauth2/authorize'))).toEqual([])
})

test('4. "Refresh now" sends one refresh_token request (no cookie, same CORS answer), lists again, and the next call carries a different bearer', async () => {
  const before = entries.filter(isApi).at(-1)!.reqHeaders.authorization
  mark = entries.length
  await page.getByRole('button', { name: 'Refresh now' }).click()
  await expect(page.getByText(CONTACT)).toBeVisible()
  await settle()
  const refreshes = tokenCalls('refresh_token', mark)
  expect(refreshes).toHaveLength(1)
  expectCredentialFree(refreshes[0]!)
  const after = sinceMark().filter(isApi)
  expect(after.length).toBeGreaterThanOrEqual(2)
  expect(after.at(-1)!.reqHeaders.authorization).not.toBe(before)
  console.log(
    'EVIDENCE token request (refresh_token):',
    JSON.stringify({
      status: refreshes[0]!.status,
      request: { cookie: refreshes[0]!.reqHeaders.cookie ?? null },
      response: {
        'access-control-allow-origin': refreshes[0]!.resHeaders['access-control-allow-origin'],
        'access-control-allow-credentials': refreshes[0]!.resHeaders['access-control-allow-credentials'] ?? null,
      },
    }),
  )
})

test('5. "Sign out" forgets the token record; signing in again needs neither the password form nor consent', async () => {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.endsWith(':token')))).toEqual([])
  mark = entries.length
  const navMark = navigations.length
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((u) => u.origin === APP && !u.searchParams.has('code') && u.pathname !== '/callback')
  await expect(page.getByText(CONTACT)).toBeVisible()
  const visited = navigations.slice(navMark)
  expect(
    visited.filter((u) => /\/app\/sign-in|consent/i.test(u)),
    'neither the password form nor consent',
  ).toEqual([])
})

test('6. after the owner deletes the client, "Refresh now" is refused (400) and the page is signed out', async ({
  request,
}) => {
  const del = await owner(request, 'DELETE', `/meta/v1/oauth-clients/${clientId}`)
  expect([200, 204], JSON.stringify(del.body)).toContain(del.status)
  mark = entries.length
  await page.getByRole('button', { name: 'Refresh now' }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByText('signed the app out')).toBeVisible()
  const refreshes = tokenCalls('refresh_token', mark)
  expect(refreshes).toHaveLength(1)
  expect(refreshes[0]!.status).toBe(400)
})

test('7. no browser console error, a CORS refusal least of all (the refused refresh of step 6 logs its own 400)', async () => {
  const unexpected = consoleErrors.filter((m) => !/Failed to load resource.*status of 400/.test(m))
  expect(unexpected).toEqual([])
})
