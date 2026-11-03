import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

// [[UI30]] PLAN, E2E steps 1 to 6 (the restarts of step 7 and the smoke of step 8 are run by hand by the tester).
// Prerequisite: a local Worker on E2E_BASE_URL (default http://localhost:8787) built from this worktree, migrated, bootstrapped with an
// API-key agent named `e2e-key` (its key in E2E_AGENT_KEY), with AUTH_PROVIDER=clerk and CLERK_AUTHORIZED_PARTIES=<the base URL>.

const SECRET = process.env.CLERK_SECRET_KEY!
const ISSUER = process.env.E2E_CLERK_ISSUER!
const AGENT_KEY = process.env.E2E_AGENT_KEY
const BAPI = 'https://api.clerk.com/v1'
const stamp = Date.now()
const email = (who: string) => `ui30-${who}-${stamp}+clerk_test@example.com`

type Role = 'owner' | 'member' | 'agent'
const users: Record<Role, { id?: string; email: string }> = { owner: { email: email('o') }, member: { email: email('m') }, agent: { email: email('g') } }

async function bapi(request: APIRequestContext, method: 'POST' | 'DELETE', path: string, data?: unknown) {
  const res = await request.fetch(`${BAPI}${path}`, { method, headers: { authorization: `Bearer ${SECRET}` }, data })
  expect(res.ok(), `${method} ${path}`).toBe(true)
  return (await res.json()) as { id: string }
}

test.beforeAll(async ({ request }) => {
  for (const role of Object.keys(users) as Role[]) {
    const u = await bapi(request, 'POST', '/users', { email_address: [users[role].email], skip_password_requirement: true, public_metadata: { vibase_role: role } })
    users[role].id = u.id
  }
})
test.afterAll(async ({ request }) => {
  for (const u of Object.values(users)) if (u.id) await request.fetch(`${BAPI}/users/${u.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${SECRET}` } })
})

const open = async (page: Page, who: Role) => {
  await page.goto('/connect')
  await clerk.loaded({ page })
  await clerk.signIn({ page, emailAddress: users[who].email })
  await page.goto('/connect')
}
const sessionToken = (page: Page) => page.evaluate(() => (window as unknown as { Clerk: { session: { getToken(): Promise<string> } } }).Clerk.session.getToken())

test('1. discovery and the headers', async ({ request, baseURL }) => {
  const doc = await (await request.get('/.well-known/vibase')).json()
  expect(doc.auth.publishable_key).toBe(process.env.CLERK_PUBLISHABLE_KEY)
  const page = await request.get('/connect')
  expect(page.status()).toBe(200)
  expect(page.headers()['content-security-policy']).toContain(new URL(ISSUER).origin)
  expect((await request.get('/connect/', { maxRedirects: 0 })).status()).toBe(308)
  const nope = await request.get('/connect/nope')
  expect(nope.status()).toBe(404)
  expect(nope.headers()['content-security-policy']).toBeTruthy()
  expect((await request.get('/health')).status()).toBe(200)
  expect(baseURL).toBeTruthy()
})

test('2. the Account Portal round trip (settles the open question)', async ({ page, context, baseURL }) => {
  await setupClerkTestingToken({ context })
  const violations: string[] = []
  page.on('console', (m) => /content security policy/i.test(m.text()) && violations.push(m.text()))
  await page.goto('/connect')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(violations).toEqual([])
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The portal's own params can sit in the hash (`#/?redirect_url=...`) at the first cross-origin navigation: wait until they are there.
  await page.waitForURL((u) => u.origin !== new URL(baseURL!).origin && (u.searchParams.has('redirect_url') || u.hash.includes('redirect_url')))
  const u = new URL(page.url())
  const back = u.searchParams.get('redirect_url') ?? new URLSearchParams(u.hash.replace(/^#\/?\??/, '')).get('redirect_url')
  expect(back).toBe(`${baseURL}/connect`)
  // Deterministic, whatever sign-in methods the instance offers: a server-side sign-in token for the owner, used as the `__clerk_ticket`
  // on the portal URL (no email code or password route is relied on).
  const res = await page.request.post(`${BAPI}/sign_in_tokens`, { headers: { authorization: `Bearer ${SECRET}` }, data: { user_id: users.owner.id } })
  expect(res.ok()).toBe(true)
  const { token } = (await res.json()) as { token: string }
  await page.goto(`${page.url()}${page.url().includes('?') ? '&' : '?'}__clerk_ticket=${token}`)
  await page.waitForURL(`${baseURL}/connect`)
  await expect(page.getByText(users.owner.email)).toBeVisible()
  await expect(page.getByText(/role: owner/)).toBeVisible()
})

test('3. owner: instructions, no MCP section, disable and enable an API-key agent', async ({ page, request, baseURL }) => {
  await open(page, 'owner')
  await expect(page.getByText(`vibase login --server ${baseURL}`)).toBeVisible()
  await expect(page.getByText('--api-key')).toBeVisible()
  await expect(page.locator('[data-section="mcp"]')).toHaveCount(0)
  const row = page.locator('li.agent', { hasText: 'e2e-key' })
  await row.getByRole('button', { name: 'Disable' }).click()
  await expect(row.getByText(/disabled 20/)).toBeVisible()
  if (AGENT_KEY) expect((await request.get('/api/v1/contacts', { headers: { authorization: `Bearer ${AGENT_KEY}` } })).status()).toBe(401)
  await row.getByRole('button', { name: 'Enable' }).click()
  await expect(row.getByText(/disabled 20/)).toHaveCount(0)
  if (AGENT_KEY) expect((await request.get('/api/v1/contacts', { headers: { authorization: `Bearer ${AGENT_KEY}` } })).status()).toBe(200)
})

test('4. agent role: no list; the owner then sees the agent account with the grant command', async ({ page, browser }) => {
  await open(page, 'agent')
  await expect(page.getByText(/role: agent/)).toBeVisible()
  await expect(page.locator('[data-section="agents"]')).toHaveCount(0)
  const ctx = await browser.newContext()
  const owner = await ctx.newPage()
  await open(owner, 'owner')
  const row = owner.locator('li.agent', { hasText: 'agent account' })
  await expect(row).toBeVisible()
  await expect(row.getByText(/vibase agents update .* --scopes/)).toBeVisible()
  await ctx.close()
})

test('5. member: the list with no buttons, and a forged PATCH is refused', async ({ page, request }) => {
  await open(page, 'member')
  await expect(page.locator('[data-section="agents"]')).toBeVisible()
  await expect(page.locator('[data-action="toggle-agent"]')).toHaveCount(0)
  const id = await page.locator('li.agent').first().getAttribute('data-agent')
  const res = await request.patch(`/meta/v1/agents/${id}`, { headers: { authorization: `Bearer ${await sessionToken(page)}` }, data: { disabled: true } })
  expect(res.status()).toBe(403)
})

test('6. sign out returns to the signed-out view', async ({ page }) => {
  await open(page, 'owner')
  await page.locator('[data-action="sign-out"]').click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})
