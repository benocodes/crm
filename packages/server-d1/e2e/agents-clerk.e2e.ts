import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

// [[UI479]] E2E (the Clerk-only legs of the deleted `e2e:connect`, [[UI30]], re-homed on the app pages `/home` and `/agents`, [[UI443]], [[UI459]]): the Account Portal round trip, the owner's
// Agents page (Disable and Enable an API-key agent), the agent role, a member, and signing out, in a real browser against a local Worker on Clerk and the Clerk DEVELOPMENT instance.
//
// Prerequisite, as for `e2e:mcp-oauth` and `e2e:action-requests`: a local Worker on E2E_BASE_URL (default http://localhost:8787) from this worktree (`pnpm -C packages/server-d1 dev`),
// a fresh local state migrated on BOTH databases (`wrangler d1 migrations apply DB --local` and `... CONTROL_DB --local`) and bootstrapped on the Clerk path
// (`bootstrap -- --org <n> --issuer <CLERK_ISSUER> --agent e2e-key`; its key exported as E2E_AGENT_KEY), with the full Clerk configuration of `.dev.vars.example` from `.env.dev`
// (AUTH_PROVIDER=clerk, CLERK_ISSUER, CLERK_JWT_KEY with its newlines escaped as \n, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, AUTH_CLI_CLIENT_ID, CLERK_AUTHORIZED_PARTIES=<base URL>).
// Keys: `.env.dev` only (playwright.config.ts). Each run creates its three Clerk test users and deletes them afterwards. Run with:  pnpm -C packages/server-d1 e2e:agents-clerk

const SECRET = process.env.CLERK_SECRET_KEY!
const ISSUER = process.env.E2E_CLERK_ISSUER!
const AGENT_KEY = process.env.E2E_AGENT_KEY
const BAPI = 'https://api.clerk.com/v1'
const stamp = Date.now()
const email = (who: string) => `ui479-${who}-${stamp}+clerk_test@example.com`

type Role = 'owner' | 'member' | 'agent'
const users: Record<Role, { id?: string; email: string }> = {
  owner: { email: email('o') },
  member: { email: email('m') },
  agent: { email: email('g') },
}

async function bapi(request: APIRequestContext, method: 'POST' | 'DELETE', path: string, data?: unknown) {
  const res = await request.fetch(`${BAPI}${path}`, { method, headers: { authorization: `Bearer ${SECRET}` }, data })
  expect(res.ok(), `${method} ${path}`).toBe(true)
  return (await res.json()) as { id: string }
}

test.beforeAll(async ({ request }) => {
  for (const role of Object.keys(users) as Role[]) {
    const u = await bapi(request, 'POST', '/users', {
      email_address: [users[role].email],
      skip_password_requirement: true,
      public_metadata: { vibase_role: role },
    })
    users[role].id = u.id
  }
})
test.afterAll(async ({ request }) => {
  for (const u of Object.values(users))
    if (u.id)
      await request.fetch(`${BAPI}/users/${u.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${SECRET}` } })
})

/** Signs `who` in with a Clerk sign-in ticket (no email code or password route) and opens `path`; waits for the session on `window.Clerk` before anything reads it. */
const open = async (page: Page, who: Role, path: string) => {
  await setupClerkTestingToken({ context: page.context() })
  await page.goto(path)
  await clerk.loaded({ page })
  await clerk.signIn({ page, emailAddress: users[who].email })
  await page.goto(path)
  await page.waitForFunction(() => (window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session, null, {
    timeout: 30000,
  })
}
const sessionToken = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { Clerk: { session: { getToken(): Promise<string> } } }).Clerk.session.getToken(),
  )
const row = (page: Page, text: string) => page.getByRole('listitem').filter({ hasText: text })

test('A. the Account Portal round trip: Sign in leaves with redirect_url <base>/home, a sign-in ticket brings the browser back signed in', async ({
  page,
  context,
  baseURL,
}) => {
  await setupClerkTestingToken({ context })
  const violations: string[] = []
  page.on('console', (m) => /content security policy/i.test(m.text()) && violations.push(m.text()))
  const response = await page.goto('/home')
  expect(response!.headers()['content-security-policy']).toContain(new URL(ISSUER).origin)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(violations).toEqual([])
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The portal's own params can sit in the hash (`#/?redirect_url=...`) at the first cross-origin navigation: wait until they are there.
  await page.waitForURL(
    (u) =>
      u.origin !== new URL(baseURL!).origin && (u.searchParams.has('redirect_url') || u.hash.includes('redirect_url')),
  )
  const u = new URL(page.url())
  const back =
    u.searchParams.get('redirect_url') ?? new URLSearchParams(u.hash.replace(/^#\/?\??/, '')).get('redirect_url')
  expect(back).toBe(`${baseURL}/home`)
  // Deterministic, whatever sign-in methods the instance offers: a server-side sign-in token for the owner, used as the `__clerk_ticket` on the portal URL.
  const res = await page.request.post(`${BAPI}/sign_in_tokens`, {
    headers: { authorization: `Bearer ${SECRET}` },
    data: { user_id: users.owner.id },
  })
  expect(res.ok()).toBe(true)
  const { token } = (await res.json()) as { token: string }
  await page.goto(`${page.url()}${page.url().includes('?') ? '&' : '?'}__clerk_ticket=${token}`)
  await page.waitForURL(`${baseURL}/home`)
  await expect(page.getByText(users.owner.email).first()).toBeVisible()
})

test('B. owner on /agents: e2e-key is an Enabled API-key agent; Disable (confirmed) refuses its key, Enable restores it; the Connect an agent section', async ({
  page,
  request,
  baseURL,
}) => {
  await open(page, 'owner', '/agents')
  const key = row(page, 'e2e-key')
  await expect(key).toBeVisible()
  await expect(key.getByText('API-key agent')).toBeVisible()
  await expect(key.getByText('Enabled', { exact: true })).toBeVisible()
  await key.getByRole('button', { name: 'Disable' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disable', exact: true }).click()
  await expect(key.getByText('Disabled', { exact: true })).toBeVisible()
  if (AGENT_KEY)
    expect(
      (await request.get('/api/v1/contacts', { headers: { authorization: `Bearer ${AGENT_KEY}` } })).status(),
    ).toBe(401)
  await key.getByRole('button', { name: 'Enable' }).click()
  await expect(key.getByText('Enabled', { exact: true })).toBeVisible()
  if (AGENT_KEY)
    expect(
      (await request.get('/api/v1/contacts', { headers: { authorization: `Bearer ${AGENT_KEY}` } })).status(),
    ).toBe(200)
  await expect(page.getByText(`vibase login --server ${baseURL}`)).toBeVisible()
  await expect(page.getByText(`${baseURL}/mcp`).first()).toBeVisible()
})

test('C. agent role: the app admits no agent principal (No access to this workspace, no Agents row); the owner then sees the agent account with the grant command', async ({
  page,
  browser,
}) => {
  // UI479 479.10/479.12: `state.ts` ([[UI443]]) refuses a principal that is not a person ("The app is for people"), so the agent-role person gets the no-access card.
  await open(page, 'agent', '/agents')
  await expect(page.getByRole('heading', { name: 'No access to this workspace' })).toBeVisible()
  await expect(page.getByText('An agent should use the MCP, the CLI or the SDK instead.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Agents' })).toHaveCount(0)
  const ctx = await browser.newContext()
  const owner = await ctx.newPage()
  await open(owner, 'owner', '/agents')
  const agent = row(owner, 'Agent account')
  await expect(agent.first()).toBeVisible()
  await expect(agent.first().getByText(/vibase agents update .* --scopes/)).toBeVisible()
  await ctx.close()
})

test('D. member: the list with no Disable, no Enable and no grant command; a forged PATCH is 403', async ({
  page,
  request,
}) => {
  await open(page, 'member', '/agents')
  await expect(page.getByRole('listitem').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disable' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Enable' })).toHaveCount(0)
  await expect(page.getByText(/vibase agents update/)).toHaveCount(0)
  const token = await sessionToken(page)
  const list = await request.get('/meta/v1/agents', { headers: { authorization: `Bearer ${token}` } })
  expect(list.status()).toBe(200)
  const id = ((await list.json()) as { data: Array<{ id: string }> }).data[0]!.id
  const res = await request.patch(`/meta/v1/agents/${id}`, {
    headers: { authorization: `Bearer ${token}` },
    data: { disabled: true },
  })
  expect(res.status()).toBe(403)
})

test('E. sign out from /agents shows the signed-out state, and Sign in on /agents leaves with redirect_url <base>/agents', async ({
  page,
  baseURL,
}) => {
  await open(page, 'owner', '/agents')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 30000 })
  await page.goto('/agents')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(
    (u) =>
      u.origin !== new URL(baseURL!).origin && (u.searchParams.has('redirect_url') || u.hash.includes('redirect_url')),
  )
  const u = new URL(page.url())
  const back =
    u.searchParams.get('redirect_url') ?? new URLSearchParams(u.hash.replace(/^#\/?\??/, '')).get('redirect_url')
  expect(back).toBe(`${baseURL}/agents`)
})
