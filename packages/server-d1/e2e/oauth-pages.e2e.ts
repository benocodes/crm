// [[UI247]] PLAN, E2E (legs 1-2; leg 3, the connect page, is [[UI297]]'s, tests 6-8): the device and consent pages in a real browser, with the real `vibase login` and an MCP-style client, against a local Worker on `better-auth` (worktree-local D1s).
// Prerequisite: fresh local state, both databases migrated, `.dev.vars` with AUTH_PROVIDER=better-auth, AUTH_SECRET (32+ characters) and PUBLIC_BASE_URL=https://localhost:8787,
// `bootstrap --org E2E --auth-provider better-auth --public-base-url https://localhost:8787 --owner-email owner@e2e.test` (E2E_INVITE_URL = the URL it printed), `wrangler dev --local --local-protocol https --port 8787` running.
// HTTPS (wrangler's self-signed certificate) and not http: the real `vibase login` refuses an issuer that is not https (`insecure_issuer`), and there is no local override. The CLI is run with
// NODE_TLS_REJECT_UNAUTHORIZED=0 and the browser context ignores the certificate error. The page must be opened at `https://localhost:8787` exactly: Better Auth's origin check trusts PUBLIC_BASE_URL only.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCOPE_DESCRIPTIONS } from '@vibase/api/scope-descriptions'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8787'
const INVITE_URL = process.env.E2E_INVITE_URL
const PKG = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(PKG, '..', 'cli', 'src', 'bin.ts')
const SHOTS = join(PKG, 'e2e-screenshots')
mkdirSync(SHOTS, { recursive: true })
const PASSWORD = 'a long enough password 123'
const CALLBACK = 'http://127.0.0.1:33999/cb' // the client's own loopback callback stays http (RFC 8252)

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
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    `axe ${name} ${scheme}`,
  ).toEqual([])
}
/** [[UI381]] D10: at 1280x720 and 390x844 the decision button is inside the viewport with the page unscrolled; when the list overflows its region, the region scrolls on its own. */
const foldCheck = async (button: string, expectScroll = false, regionName = 'Requested permissions') => {
  for (const size of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size)
    await page.evaluate(() => window.scrollTo(0, 0))
    const box = await page.getByRole('button', { name: button, exact: true }).boundingBox()
    expect(box, `${button} at ${size.width}x${size.height}`).not.toBeNull()
    expect(box!.y + box!.height, `${button} inside the fold at ${size.width}x${size.height}`).toBeLessThanOrEqual(
      size.height,
    )
    const region = page.getByRole('region', { name: regionName })
    await expect(region).toHaveAttribute('tabindex', '0')
    if (expectScroll)
      expect(await region.evaluate((el) => el.scrollHeight > el.clientHeight), 'the scope region scrolls').toBe(true)
  }
  await page.setViewportSize({ width: 1280, height: 720 })
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
  await page.evaluate(() =>
    fetch('/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  )
}

/** The real `vibase login` (tsx on the CLI source), its config in a private directory. Resolves the `/app/device` URL it prints; `done` resolves with its exit code and output. */
function startLogin(): Promise<{
  url: string
  home: string
  done: Promise<{ code: number; stdout: string; stderr: string }>
}> {
  const home = mkdtempSync(join(tmpdir(), 'vibase-e2e-'))
  const child: ChildProcessWithoutNullStreams = spawn('pnpm', ['exec', 'tsx', CLI, 'login', '--server', BASE], {
    cwd: PKG,
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, HOME: home },
  })
  let stdout = ''
  let stderr = ''
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr })),
  )
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`vibase login printed no URL: ${stderr}`)), 30_000)
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
      const m = /open (\S+\/app\/device\?user_code=[A-Z0-9]{8})/.exec(stderr)
      if (m) {
        clearTimeout(timer)
        resolve({ url: m[1]!, home, done })
      }
    })
  })
}

test('0. the invited person signs up (the shared session), then signs out', async () => {
  expect(INVITE_URL, 'E2E_INVITE_URL: the URL bootstrap printed').toBeTruthy()
  // UI510 D7: the link the vault builds names the page under /app.
  expect(INVITE_URL!.startsWith('https://localhost:8787/app/invite#token=')).toBe(true)
  await visit(INVITE_URL!)
  await page.getByLabel('Name').fill('Owner Person')
  await page.getByLabel('Email').fill('owner@e2e.test')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  // A finished sign-up lands on /app/home (UI461 D3); /sign-in then shows the signed-in view.
  await page.waitForURL((u) => u.pathname === '/app/home')
  await visit('/app/sign-in')
  await expect(page.getByText('Signed in as owner@e2e.test')).toBeVisible()
  await signOutHere()
})

test('1. device: the printed URL leads through sign-in to the code, the review and Approve; the CLI exits 0 and names the person', async () => {
  const login = await startLogin()
  const code = new URL(login.url).searchParams.get('user_code')!
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
  expect(new URL(login.url).pathname).toBe('/app/device')
  await visit(login.url)
  await page.waitForURL(/\/app\/sign-in\?return_to=/)
  await signInHere()
  await page.waitForURL(/\/app\/device\?user_code=/)
  // [[UI381]] D9: the link is claimed on load; the review is there with no Check click
  await expect(page.getByText('Vibase CLI')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check code' })).toHaveCount(0)
  await expect(page.getByText(`${code.slice(0, 4)}-${code.slice(4)}`)).toBeVisible()
  await expect(page.getByText('Approve only if you started this sign-in yourself')).toBeVisible()
  await foldCheck('Approve')
  await axeBoth('device-review')
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('You can return to your terminal')).toBeVisible()
  await axeBoth('device-approved')
  const result = await login.done
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('owner@e2e.test')
  // the stored credential works for a later command: `vibase me get` with the same private config directory
  const me = await new Promise<{ code: number; out: string }>((resolve) => {
    const c = spawn('pnpm', ['exec', 'tsx', CLI, 'me', 'get', '--server', BASE], {
      cwd: PKG,
      env: {
        ...process.env,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        XDG_CONFIG_HOME: login.home,
        XDG_CACHE_HOME: login.home,
        HOME: login.home,
      },
    })
    let out = ''
    c.stdout.on('data', (b: Buffer) => (out += b.toString()))
    c.stderr.on('data', (b: Buffer) => (out += b.toString()))
    c.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
  expect(me.code, me.out).toBe(0)
  expect(me.out).toContain('owner@e2e.test')
})

test('2. device: Deny ends the CLI with its denial message', async () => {
  const login = await startLogin()
  await visit(login.url)
  // the session of step 1 is still live: the link opens straight on the review
  await expect(page.getByText('Vibase CLI')).toBeVisible()
  await page.getByRole('button', { name: 'Deny' }).click()
  await expect(page.getByText(/Denied/).first()).toBeVisible()
  const result = await login.done
  expect(result.code).not.toBe(0)
  expect(result.stderr.toLowerCase()).toMatch(/denied/)
})

test('2b. device: a typed code still goes through Check code (the code form keeps its axe pass)', async () => {
  const login = await startLogin()
  const code = new URL(login.url).searchParams.get('user_code')!
  await visit(`${BASE}/app/device`)
  await expect(page.getByLabel('Code from your terminal')).toBeVisible()
  await axeBoth('device-code')
  await page.getByLabel('Code from your terminal').fill(code)
  await page.getByRole('button', { name: 'Check code' }).click()
  await expect(page.getByText('Vibase CLI')).toBeVisible()
  await page.getByRole('button', { name: 'Deny' }).click()
  await expect(page.getByText(/Denied/).first()).toBeVisible()
  await login.done
})

const pkce = () => {
  const verifier = randomBytes(40).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
async function register(name: string): Promise<string> {
  const res = await page.request.post('/auth/oauth2/register', {
    headers: { origin: BASE },
    data: {
      client_name: name,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [CALLBACK],
      scope: 'openid offline_access contacts:read',
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}
const authorizeUrl = (clientId: string, challenge: string, state: string, scope = 'openid contacts:read') =>
  `${BASE}/auth/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, scope, state, code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` })}`

/** Catches the browser's redirect to the loopback callback (nothing listens there) and returns its URL. */
async function callbackOf(action: () => Promise<void>): Promise<URL> {
  const seen = page.waitForRequest((r) => r.url().startsWith(CALLBACK), { timeout: 90_000 })
  await page.route(`${CALLBACK}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'callback' }),
  )
  await action()
  return new URL((await seen).url())
}

test('3. MCP-style client: sign-in resumes the flow, /consent shows the app, Allow returns a code that works at /mcp', async () => {
  // signed out first: the device legs left a session behind, and a signed-in authorize would go straight to /consent
  await visit('/app/sign-in')
  await signOutHere()
  const id = await register('E2E MCP Client')
  const { verifier, challenge } = pkce()
  await visit(authorizeUrl(id, challenge, 'state-allow'))
  await page.waitForURL(/\/app\/sign-in\?/)
  expect(new URL(page.url()).searchParams.get('sig')).toBeTruthy()
  await expect(page.getByLabel('Email')).toBeVisible()
  const back = await callbackOf(async () => {
    await signInHere()
    await page.waitForURL(/\/app\/consent\?/)
    await expect(page.getByText('E2E MCP Client')).toBeVisible()
    await expect(page.getByText('This name is chosen by the app and not verified by Vibase')).toBeVisible()
    await expect(page.getByText('After you allow, you go back to 127.0.0.1:33999')).toBeVisible()
    // [[UI455]]: the request is grouped; its scopes sit inside a closed disclosure of the area
    await expect(page.getByText('CRM records', { exact: true })).toBeVisible()
    await expect(page.getByText('contacts:read')).toBeHidden()
    await page.getByText('Show the 1 permission', { exact: true }).last().click()
    await expect(page.getByText('contacts:read')).toBeVisible()
    await foldCheck('Allow', false, 'Permissions by area')
    await axeBoth('consent')
    await page.getByRole('button', { name: 'Allow' }).click()
  })
  expect(back.searchParams.get('state')).toBe('state-allow')
  const code = back.searchParams.get('code')!
  expect(code).toBeTruthy()
  const tok = await page.request.post('/auth/oauth2/token', {
    headers: { origin: BASE },
    form: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      client_id: id,
      resource: `${BASE}/mcp`,
    },
  })
  expect(tok.status(), await tok.text()).toBe(200)
  const access = ((await tok.json()) as { access_token: string }).access_token
  const mcp = await page.request.post('/mcp', {
    headers: { authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })
  expect(mcp.status(), await mcp.text()).toBe(200)
})

test('3b. /consent with a long scope set: Allow stays in the fold and the scope region scrolls', async () => {
  const scopes = ['openid', ...Object.keys(SCOPE_DESCRIPTIONS).slice(0, 14)].join(' ')
  const res = await page.request.post('/auth/oauth2/register', {
    headers: { origin: BASE },
    data: {
      client_name: 'E2E Long Scopes',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      redirect_uris: [CALLBACK],
      scope: scopes,
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  const id = ((await res.json()) as { client_id: string }).client_id
  const { challenge } = pkce()
  await visit(authorizeUrl(id, challenge, 'state-long', scopes))
  await page.waitForURL(/\/app\/consent\?/)
  await expect(page.getByText('E2E Long Scopes')).toBeVisible()
  await foldCheck('Allow', true, 'Permissions by area')
  await axeBoth('consent-long')
})

test('3c. /consent with no scope asked: the areas and their defaults, Write forces Propose, Allow grants exactly what is on, and a second authorize starts from the defaults again', async () => {
  // [[UI455]]: the person is still signed in from leg 3. A client with no `scope` and an authorize with none (the CORE330 fill).
  const res = await page.request.post('/auth/oauth2/register', {
    headers: { origin: BASE },
    data: {
      client_name: 'E2E Naive Client',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      redirect_uris: [CALLBACK],
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  const id = ((await res.json()) as { client_id: string }).client_id
  const bare = (challenge: string, state: string) =>
    `${BASE}/auth/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: CALLBACK, state, code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` })}`
  const { verifier, challenge } = pkce()
  const swt = (area: string, action: string) => page.getByRole('switch', { name: `${area} ${action}`, exact: true })
  let consentBody: { oauth_query: string; scope?: string; accept: boolean } | undefined
  let pageQuery = ''
  const back = await callbackOf(async () => {
    await visit(bare(challenge, 'state-naive'))
    await page.waitForURL(/\/app\/consent\?/)
    pageQuery = new URL(page.url()).search.slice(1)
    await expect(page.getByTestId('sign-in-line')).toBeVisible()
    const legends = await page.locator('fieldset legend').allTextContents()
    expect(legends).toEqual(['CRM records', 'Messages', 'Activity and approvals', 'Integrations'])
    const defaults = await page.getByRole('switch').evaluateAll((els) =>
      els.map((el) => ({
        label: document.getElementById(el.getAttribute('aria-labelledby')!.split(' ')[1]!)!.textContent,
        on: el.getAttribute('aria-checked'),
      })),
    )
    expect(defaults.length).toBeGreaterThan(0)
    for (const d of defaults) expect(d.on, `${d.label} default`).toBe(d.label === 'Write' ? 'false' : 'true')
    await foldCheck('Allow', true, 'Permissions by area')
    await axeBoth('consent-grouped')
    await swt('CRM records', 'Write').click()
    await expect(swt('CRM records', 'Propose changes for approval')).toBeDisabled()
    await expect(swt('CRM records', 'Propose changes for approval')).toHaveAttribute('aria-checked', 'true')
    await swt('Messages', 'Read').click()
    const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/auth/oauth2/consent'))
    await page.getByRole('button', { name: 'Allow' }).click()
    consentBody = (await posted).postDataJSON()
  })
  expect(consentBody!.oauth_query).toBe(pageQuery)
  const granted = consentBody!.scope!.split(' ')
  expect(granted).toEqual(
    expect.arrayContaining(['openid', 'offline_access', 'contacts:write', 'contacts:request_approval']),
  )
  for (const no of ['messages:read', 'webhooks:write', 'audit:read']) expect(granted).not.toContain(no)
  const tok = await page.request.post('/auth/oauth2/token', {
    headers: { origin: BASE },
    form: {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      client_id: id,
      resource: `${BASE}/mcp`,
    },
  })
  expect(tok.status(), await tok.text()).toBe(200)
  expect(new Set(((await tok.json()) as { scope: string }).scope.split(' '))).toEqual(new Set(granted))
  // the same client again: consent is asked again, from the defaults (nothing is remembered)
  await visit(bare(pkce().challenge, 'state-again'))
  await page.waitForURL(/\/app\/consent\?/)
  await expect(swt('CRM records', 'Write')).toHaveAttribute('aria-checked', 'false')
})

test('4. MCP-style client: Deny reaches the callback with error=access_denied', async () => {
  const id = await register('E2E MCP Client 2')
  const { challenge } = pkce()
  const back = await callbackOf(async () => {
    await visit(authorizeUrl(id, challenge, 'state-deny'))
    await page.waitForURL(/\/app\/consent\?/)
    await page.getByRole('button', { name: 'Deny' }).click()
  })
  expect(back.searchParams.get('error')).toBe('access_denied')
  expect(back.searchParams.get('state')).toBe('state-deny')
})

test('5. every new page carries the exact headers; /consent without a request explains; the old paths are 404', async ({
  request,
}) => {
  for (const old of ['/sign-in', '/device', '/consent', '/invite', '/reset-password']) {
    const res = await request.get(old, { ignoreHTTPSErrors: true, maxRedirects: 0 } as never)
    expect(res.status(), old).toBe(404)
  }
  for (const path of ['/app/consent', '/app/device']) {
    const res = await request.get(path, { ignoreHTTPSErrors: true } as never)
    expect(res.status(), path).toBe(200)
    expect(res.headers()['content-security-policy'], path).toContain("default-src 'self'")
    expect(res.headers()['cache-control'], path).toBe('no-store')
  }
  await visit('/app/consent')
  await expect(page.getByText(/must be opened by an app/)).toBeVisible()
  await axeBoth('consent-no-request')
})

// [[UI297]] leg 3 of [[UI247]] D8, moved to the Agents page by [[UI476]]: the app's `/app/agents` on `better-auth`, in the same browser context (the session of the legs above is live, and leg 2 left one delegated agent).
const sessionEmail = (p: Page) =>
  p.evaluate(
    async () =>
      ((await (await fetch('/auth/get-session')).json()) as { user?: { email?: string } } | null)?.user?.email,
  )

test('6. /app/agents signed in: the delegated agent agents.list returns is listed as Signed in through you, a self-only CSP, no request leaves the origin', async () => {
  const outside: string[] = []
  const listener = (r: { url(): string }) => {
    if (
      !r.url().startsWith(BASE) &&
      !r.url().startsWith('about:') &&
      !r.url().startsWith('data:') &&
      !r.url().startsWith('blob:')
    )
      outside.push(r.url())
  }
  page.on('request', listener)
  const response = await page.goto(`${BASE}/app/agents`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agents')
  // the name agents.list returns for the delegated agent (delegated_by is the person), read with the session token the page itself uses
  const listed = await page.evaluate(async () => {
    const { token } = (await (await fetch('/auth/token')).json()) as { token: string }
    const res = await fetch('/meta/v1/agents?limit=200', { headers: { authorization: `Bearer ${token}` } })
    return ((await res.json()) as { data: { name: string; delegated_by: string | null }[] }).data
  })
  const delegated = listed.filter((a) => a.delegated_by !== null)
  expect(delegated.length, 'leg 2 left a delegated agent').toBeGreaterThan(0)
  const list = page.getByRole('list', { name: 'Connected agents' })
  for (const a of delegated)
    await expect(list.getByRole('listitem').filter({ hasText: a.name }).first()).toContainText('Signed in through you')
  page.off('request', listener)
  const csp = response!.headers()['content-security-policy']!
  expect(csp).toContain("default-src 'self'")
  expect(csp).not.toMatch(/clerk|challenges\.cloudflare\.com/i)
  expect(outside, 'no request leaves the origin').toEqual([])
  await axeBoth('agents-signed-in')
})

// [[UI461]] D10, [[UI469]] D13: leg 2 left a delegated agent, so Home has no Connect an agent prompt; the owner holds `connections:write` and owns no mailbox, so Get started shows Connect your email alone.
test('6b. /app/home with a delegated agent: Get started shows Connect your email and no Connect an agent prompt', async () => {
  // Wait for both reads, so the absence below is a result and not a page still loading.
  const agentsRead = page.waitForResponse((r) => r.url().includes('/meta/v1/agents') && r.status() === 200)
  const connectionsRead = page.waitForResponse((r) => r.url().includes('/meta/v1/connections') && r.status() === 200)
  await page.goto('/app/home')
  await agentsRead
  await connectionsRead
  await expect(page.getByRole('region', { name: 'Who you are' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Get started' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Connect your email' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Connect an agent' })).toHaveCount(0)
})

test('7. /app/agents: Sign out shows the signed-out card; get-session answers null', async () => {
  await visit(`${BASE}/app/agents`)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(await page.evaluate(async () => (await (await fetch('/auth/get-session')).text()).trim())).toBe('null')
  await axeBoth('agents-signed-out')
})

test('8. /app/agents: Sign in goes to /sign-in?return_to=/app/agents and comes back signed in as the same person', async () => {
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((u) => u.pathname === '/app/sign-in' && u.searchParams.get('return_to') === '/app/agents')
  await signInHere()
  await page.waitForURL((u) => u.pathname === '/app/agents')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agents')
  expect(await sessionEmail(page)).toBe('owner@e2e.test')
})

// [[UI507]] D6: `/connect` is gone: 404, never a redirect.
test('8b. /connect?x=1 and /connect/connect.js are 404, never a redirect', async ({ request }) => {
  for (const path of ['/connect?x=1', '/connect', '/connect/connect.js']) {
    const raw = await request.get(`${BASE}${path}`, { maxRedirects: 0, ignoreHTTPSErrors: true } as never)
    expect(raw.status(), path).toBe(404)
    expect(raw.headers().location, path).toBeUndefined()
  }
})
