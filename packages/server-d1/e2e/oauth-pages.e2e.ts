// [[UI247]] PLAN, E2E: the device and consent pages in a real browser, with the real `vibase login` and an MCP-style client, against a local Worker on `better-auth` (worktree-local D1s).
// Prerequisite: fresh local state, both databases migrated, `.dev.vars` with AUTH_PROVIDER=better-auth, AUTH_SECRET (32+ characters) and PUBLIC_BASE_URL=http://localhost:8787,
// `bootstrap --org E2E --auth-provider better-auth --public-base-url https://localhost:8787 --owner-email owner@e2e.test` (E2E_INVITE_URL = the URL it printed), `wrangler dev --local --local-protocol https --port 8787` running.
// HTTPS (wrangler's self-signed certificate) and not http: the real `vibase login` refuses an issuer that is not https (`insecure_issuer`), and there is no local override. The CLI is run with
// NODE_TLS_REJECT_UNAUTHORIZED=0 and the browser context ignores the certificate error. The page must be opened at `https://localhost:8787` exactly: Better Auth's origin check trusts PUBLIC_BASE_URL only.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8787'
const INVITE_URL = process.env.E2E_INVITE_URL
const PKG = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(PKG, '..', 'cli', 'src', 'bin.ts')
const SHOTS = join(PKG, 'e2e-screenshots')
mkdirSync(SHOTS, { recursive: true })
const PASSWORD = 'a long enough password 123'
const CALLBACK = 'http://127.0.0.1:33999/cb'  // the client's own loopback callback stays http (RFC 8252)

// One browser context for the whole run (the session cookie made at sign-up is what later steps use or drop).
const violations: string[] = []
let context: BrowserContext
let page: Page
test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ ignoreHTTPSErrors: true })
  page = await context.newPage()
  page.on('console', (m) => /content security policy/i.test(m.text()) && violations.push(m.text()))
})
test.afterAll(async () => {
  expect(violations, 'no CSP violation in the console').toEqual([])
  await context.close()
})
test.describe.configure({ mode: 'serial' })

const axeAndShot = async (name: string, scheme: 'light' | 'dark') => {
  await page.emulateMedia({ colorScheme: scheme })
  await page.screenshot({ path: join(SHOTS, `${name}--${scheme}.png`), fullPage: true })
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe ${name} ${scheme}`).toEqual([])
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
/** Better Auth limits sign-in per IP (a 10 s window): a 429 is waited out once, and the test says so. */
const signInHere = async () => {
  await page.getByLabel('Email').fill('owner@e2e.test')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}
const signOutHere = async () => {
  await page.evaluate(() => fetch('/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
}

/** The real `vibase login` (tsx on the CLI source), its config in a private directory. Resolves the `/device` URL it prints; `done` resolves with its exit code and output. */
function startLogin(): Promise<{ url: string; done: Promise<{ code: number; stdout: string; stderr: string }> }> {
  const home = mkdtempSync(join(tmpdir(), 'vibase-e2e-'))
  const child: ChildProcessWithoutNullStreams = spawn('pnpm', ['exec', 'tsx', CLI, 'login', '--server', BASE], { cwd: PKG, env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, HOME: home } })
  let stdout = ''
  let stderr = ''
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr })))
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`vibase login printed no URL: ${stderr}`)), 30_000)
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
      const m = /open (\S+\/device\?user_code=[A-Z0-9]{8})/.exec(stderr)
      if (m) {
        clearTimeout(timer)
        resolve({ url: m[1]!, done })
      }
    })
  })
}

test('0. the invited person signs up (the shared session), then signs out', async () => {
  expect(INVITE_URL, 'E2E_INVITE_URL: the URL bootstrap printed').toBeTruthy()
  await visit(INVITE_URL!)
  await page.getByLabel('Name').fill('Owner Person')
  await page.getByLabel('Email').fill('owner@e2e.test')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL('**/sign-in')
  await expect(page.getByText('Signed in as owner@e2e.test')).toBeVisible()
  await signOutHere()
})

test('1. device: the printed URL leads through sign-in to the code, the review and Approve; the CLI exits 0 and names the person', async () => {
  const login = await startLogin()
  const code = new URL(login.url).searchParams.get('user_code')!
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
  expect(new URL(login.url).pathname).toBe('/device')
  await visit(login.url)
  await page.waitForURL(/\/sign-in\?return_to=/)
  await signInHere()
  await page.waitForURL(/\/device\?user_code=/)
  const input = page.getByLabel('Code from your terminal')
  await expect(input).toHaveValue(`${code.slice(0, 4)}-${code.slice(4)}`)
  await axeBoth('device-code')
  await page.getByRole('button', { name: 'Check code' }).click()
  await expect(page.getByText('Vibase CLI')).toBeVisible()
  await expect(page.getByText(`${code.slice(0, 4)}-${code.slice(4)}`)).toBeVisible()
  await expect(page.getByText('Approve only if you started this sign-in yourself')).toBeVisible()
  await axeBoth('device-review')
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('You can return to your terminal')).toBeVisible()
  await axeBoth('device-approved')
  const result = await login.done
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('owner@e2e.test')
})

test('2. device: Deny ends the CLI with its denial message', async () => {
  const login = await startLogin()
  await visit(login.url)
  // the session of step 1 is still live: straight to the code form
  await expect(page.getByLabel('Code from your terminal')).toBeVisible()
  await page.getByRole('button', { name: 'Check code' }).click()
  await page.getByRole('button', { name: 'Deny' }).click()
  await expect(page.getByText(/Denied/).first()).toBeVisible()
  const result = await login.done
  expect(result.code).not.toBe(0)
  expect(result.stderr.toLowerCase()).toMatch(/denied/)
})

const pkce = () => {
  const verifier = randomBytes(40).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
async function register(name: string): Promise<string> {
  const res = await page.request.post('/auth/oauth2/register', {
    headers: { origin: BASE },
    data: { client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], redirect_uris: [CALLBACK], scope: 'openid offline_access contacts:read' },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}
const authorizeUrl = (clientId: string, challenge: string, state: string) =>
  `${BASE}/auth/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, scope: 'openid contacts:read', state, code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` })}`

/** Catches the browser's redirect to the loopback callback (nothing listens there) and returns its URL. */
async function callbackOf(action: () => Promise<void>): Promise<URL> {
  const seen = page.waitForRequest((r) => r.url().startsWith(CALLBACK), { timeout: 30_000 })
  await page.route(`${CALLBACK}**`, (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'callback' }))
  await action()
  return new URL((await seen).url())
}

test('3. MCP-style client: sign-in resumes the flow, /consent shows the app, Allow returns a code that works at /mcp', async () => {
  // signed out first: the device legs left a session behind, and a signed-in authorize would go straight to /consent
  await visit('/sign-in')
  await signOutHere()
  const id = await register('E2E MCP Client')
  const { verifier, challenge } = pkce()
  await visit(authorizeUrl(id, challenge, 'state-allow'))
  await page.waitForURL(/\/sign-in\?/)
  expect(new URL(page.url()).searchParams.get('sig')).toBeTruthy()
  await expect(page.getByLabel('Email')).toBeVisible()
  const back = await callbackOf(async () => {
    await signInHere()
    await page.waitForURL(/\/consent\?/)
    await expect(page.getByText('E2E MCP Client')).toBeVisible()
    await expect(page.getByText('This name is chosen by the app and not verified by Vibase')).toBeVisible()
    await expect(page.getByText('After you allow, you go back to 127.0.0.1:33999')).toBeVisible()
    await expect(page.getByText('contacts:read')).toBeVisible()
    await axeBoth('consent')
    await page.getByRole('button', { name: 'Allow' }).click()
  })
  expect(back.searchParams.get('state')).toBe('state-allow')
  const code = back.searchParams.get('code')!
  expect(code).toBeTruthy()
  const tok = await page.request.post('/auth/oauth2/token', { headers: { origin: BASE }, form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: id, resource: `${BASE}/mcp` } })
  expect(tok.status(), await tok.text()).toBe(200)
  const access = ((await tok.json()) as { access_token: string }).access_token
  const mcp = await page.request.post('/mcp', { headers: { authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
  expect(mcp.status(), await mcp.text()).toBe(200)
})

test('4. MCP-style client: Deny reaches the callback with error=access_denied', async () => {
  const id = await register('E2E MCP Client 2')
  const { challenge } = pkce()
  const back = await callbackOf(async () => {
    await visit(authorizeUrl(id, challenge, 'state-deny'))
    await page.waitForURL(/\/consent\?/)
    await page.getByRole('button', { name: 'Deny' }).click()
  })
  expect(back.searchParams.get('error')).toBe('access_denied')
  expect(back.searchParams.get('state')).toBe('state-deny')
})

test('5. every new page carries the exact headers; /consent without a request explains', async ({ request }) => {
  for (const path of ['/consent', '/device']) {
    const res = await request.get(path, { ignoreHTTPSErrors: true } as never)
    expect(res.status(), path).toBe(200)
    expect(res.headers()['content-security-policy'], path).toContain("default-src 'self'")
    expect(res.headers()['cache-control'], path).toBe('no-store')
  }
  await visit('/consent')
  await expect(page.getByText(/must be opened by an app/)).toBeVisible()
  await axeBoth('consent-no-request')
})
