import { execFileSync } from 'node:child_process'
import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

// [[API115]] E2E (API106 cycle 2; Milestone A pass P1 and P4 with a real token): a standard MCP client, given only `<origin>/mcp`, discovers Clerk,
// registers by DCR, gets a person's consent and works through /mcp as that person's delegated agent, which an owner then disables.
//
// Prerequisite, as for the connect E2E: a local Worker on E2E_BASE_URL (default http://localhost:8787) from this worktree (`pnpm -C packages/server-d1 dev`),
// its local D1 migrated and bootstrapped on the Clerk path (`bootstrap -- --org <n> --issuer <CLERK_ISSUER>`), with the full Clerk configuration of
// `.dev.vars.example` from `.env.dev` (AUTH_PROVIDER=clerk, CLERK_ISSUER, CLERK_JWT_KEY, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, AUTH_CLI_CLIENT_ID,
// CLERK_AUTHORIZED_PARTIES=<base URL>). The database it reads is that Worker's LOCAL D1 (`wrangler d1 execute DB --local`), never a remote one.
// Keys: `.env.dev` only (playwright.config.ts). Run with:  pnpm -C packages/server-d1 e2e:mcp-oauth
//
// How the grant is narrowed (step 6): the client asks for the challenge's scope list minus `tasks:write` (the SDK's `auth()` takes an explicit `scope`
// that wins over the challenge's, and the same value is sent in the DCR and the authorize request). A member's role does not narrow it: every
// agent-grantable scope is member-grantable, so only the requested scope can leave `tasks:write` out. `tasks_create` is then a tool the agent lacks.

const SECRET = process.env.CLERK_SECRET_KEY!
const ISSUER = process.env.E2E_CLERK_ISSUER!
const BAPI = 'https://api.clerk.com/v1'
const stamp = Date.now()
const CLIENT_NAME = `api115-e2e-${stamp}`
const REDIRECT = 'http://127.0.0.1:43111/callback'
const email = (who: string) => `api115-${who}-${stamp}+clerk_test@example.com`
const LEFT_OUT = 'tasks:write'

type Role = 'owner' | 'member'
const users: Record<Role, { id?: string; email: string }> = { owner: { email: email('o') }, member: { email: email('m') } }

const bapi = async (request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, data?: unknown) => {
  const res = await request.fetch(`${BAPI}${path}`, { method, headers: { authorization: `Bearer ${SECRET}` }, data })
  expect(res.ok(), `${method} ${path}`).toBe(true)
  return (await res.json()) as any
}

/** The local D1 of the running `wrangler dev` (same persisted state as `wrangler d1 execute --local`). */
const sql = (query: string): Array<Record<string, any>> => {
  const out = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--json', '--command', query], { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } })
  return JSON.parse(out.slice(out.indexOf('[')))[0].results
}

/** An in-memory OAuthClientProvider with a loopback redirect: the authorize URL is captured, nothing listens. */
class Provider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed
  saved?: OAuthTokens
  verifier = ''
  authorizeUrl?: URL
  readonly redirectUrl = REDIRECT
  readonly clientMetadata: OAuthClientMetadata = { client_name: CLIENT_NAME, redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
  state = () => 'api115-state'
  clientInformation = () => this.info
  saveClientInformation = (i: OAuthClientInformationMixed) => void (this.info = i)
  tokens = () => this.saved
  saveTokens = (t: OAuthTokens) => void (this.saved = t)
  redirectToAuthorization = (u: URL) => void (this.authorizeUrl = u)
  saveCodeVerifier = (v: string) => void (this.verifier = v)
  codeVerifier = () => this.verifier
}

test.beforeAll(async ({ request }) => {
  // Initial state on the dev instance: DCR on (the scopes are the instance's custom catalog, proven by the Vibase CLI application).
  const settings = await bapi(request, 'GET', '/instance/oauth_application_settings')
  if (!settings.dynamic_oauth_client_registration) await bapi(request, 'PATCH', '/instance/oauth_application_settings', { dynamic_oauth_client_registration: true })
  for (const role of Object.keys(users) as Role[]) {
    const u = await bapi(request, 'POST', '/users', { email_address: [users[role].email], skip_password_requirement: true, public_metadata: { vibase_role: role } })
    users[role].id = u.id
  }
})
test.afterAll(async ({ request }) => {
  for (const u of Object.values(users)) if (u.id) await request.fetch(`${BAPI}/users/${u.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${SECRET}` } })
  const apps = await request.fetch(`${BAPI}/oauth_applications?limit=100`, { headers: { authorization: `Bearer ${SECRET}` } })
  if (apps.ok()) for (const a of ((await apps.json()) as any).data ?? []) if (a.name === CLIENT_NAME) await request.fetch(`${BAPI}/oauth_applications/${a.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${SECRET}` } })
})

const provider = new Provider()
let serverUrl = ''
let challengeScopes: string[] = []
let client: Client
let delegatedAgentId = ''

test('1. an unauthenticated initialize is 401 with the /mcp challenge', async ({ request, baseURL }) => {
  serverUrl = `${baseURL}/mcp`
  const res = await request.post('/mcp', { headers: { 'content-type': 'application/json' }, data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } } })
  expect(res.status()).toBe(401)
  const header = res.headers()['www-authenticate']!
  const m = new RegExp(`^Bearer resource_metadata="${baseURL!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.well-known/oauth-protected-resource/mcp", scope="([a-z_:]+(?: [a-z_:]+)*)"$`).exec(header)
  expect(m, header).not.toBeNull()
  challengeScopes = m![1]!.split(' ')
  expect(challengeScopes).toContain('contacts:write')
  expect(challengeScopes).toContain(LEFT_OUT)
  for (const human of ['agents:write', 'agents:read', 'members:read']) expect(challengeScopes).not.toContain(human)
  const parsed = extractWWWAuthenticateParams(new Response(null, { status: 401, headers: { 'www-authenticate': header } }))
  expect(parsed.resourceMetadataUrl?.href).toBe(`${baseURL}/.well-known/oauth-protected-resource/mcp`)
})

test('2. the SDK discovers the document and Clerk, and registers by DCR', async ({ request, baseURL }) => {
  const doc = await (await request.get('/.well-known/oauth-protected-resource/mcp')).json()
  expect(doc.resource).toBe(`${baseURL}/mcp`)
  expect(doc.authorization_servers).toEqual([ISSUER])
  const narrowed = challengeScopes.filter((s) => s !== LEFT_OUT).join(' ')
  const result = await auth(provider, { serverUrl, resourceMetadataUrl: new URL(`${baseURL}/.well-known/oauth-protected-resource/mcp`), scope: narrowed })
  expect(result).toBe('REDIRECT')
  expect(provider.info?.client_id).toBeTruthy()
  const url = provider.authorizeUrl!
  expect(url.origin).toBe(new URL(ISSUER).origin)
  expect(url.searchParams.get('resource')).toBe(`${baseURL}/mcp`)
  expect(url.searchParams.get('scope')!.split(' ')).not.toContain(LEFT_OUT)
  const apps = (await bapi(request, 'GET', '/oauth_applications?limit=100')).data as Array<{ name: string; dynamically_registered?: boolean }>
  expect(apps.some((a) => a.name === CLIENT_NAME)).toBe(true)
})

test('3. the member signs in with a sign-in ticket, consents on Clerk, and the code becomes tokens', async ({ page, context, request }) => {
  await setupClerkTestingToken({ context })
  let callback: URL | undefined
  await page.route('http://127.0.0.1:43111/**', (route) => {
    callback = new URL(route.request().url())
    return route.fulfill({ status: 200, contentType: 'text/plain', body: 'captured' })
  })
  await page.goto(provider.authorizeUrl!.href)
  await page.waitForURL((u) => u.origin !== new URL(ISSUER).origin && (u.searchParams.has('redirect_url') || u.hash.includes('redirect_url')))
  const { token } = (await bapi(request, 'POST', '/sign_in_tokens', { user_id: users.member.id })) as { token: string }
  await page.goto(`${page.url()}${page.url().includes('?') ? '&' : '?'}__clerk_ticket=${token}`)
  // Clerk's hosted consent screen: its button labels are not under our control, so match the usual ones and keep trying until the loopback is hit.
  const consent = page.getByRole('button', { name: /^(allow|authorize|accept|approve|continue)/i }).first()
  const deadline = Date.now() + 60_000
  while (!callback && Date.now() < deadline) {
    if (await consent.isVisible().catch(() => false)) await consent.click().catch(() => {})
    await page.waitForTimeout(500)
  }
  expect(callback, `the redirect to ${REDIRECT} was not reached; last URL ${page.url()}`).toBeDefined()
  expect(callback!.searchParams.get('state')).toBe('api115-state')
  const code = callback!.searchParams.get('code')!
  expect(code).toBeTruthy()
  const result = await auth(provider, { serverUrl, authorizationCode: code, scope: challengeScopes.filter((s) => s !== LEFT_OUT).join(' ') })
  expect(result).toBe('AUTHORIZED')
  expect(provider.saved?.access_token).toBeTruthy()
})

test('4. initialize returns the instructions; tools/list holds no human-only tool', async () => {
  client = new Client({ name: CLIENT_NAME, version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider }))
  expect(client.getInstructions()).toContain('me_get')
  const names = (await client.listTools()).tools.map((t) => t.name)
  expect(names).toContain('contacts_create')
  expect(names).toContain('schema_get')
  expect(names).not.toContain('tasks_create')
  expect(names.filter((n) => /^(agents|memberships|users|members)_/.test(n))).toEqual([])
})

test('5. contacts_create succeeds and its event names a new delegated agent for the member, named after the client', async () => {
  const res = (await client.callTool({ name: 'contacts_create', arguments: { name: `Ada ${stamp}` } })) as { isError?: boolean; structuredContent?: { id: string } }
  expect(res.isError).toBeFalsy()
  const contactId = res.structuredContent!.id
  const event = sql(`select actor_id from events where type = 'contact.created' and resource_id = '${contactId}'`)
  expect(event, 'a contact.created event for the contact').toHaveLength(1)
  delegatedAgentId = event[0]!.actor_id
  const agent = sql(`select id, name, disabled_at from agents where id = '${delegatedAgentId}'`)
  expect(agent).toHaveLength(1)
  expect(agent[0]!.name).toBe(`${CLIENT_NAME} (${users.member.email})`)
  expect(agent[0]!.disabled_at).toBeNull()
})

test('6. a tool outside the granted scopes is a tool error insufficient_scope with HTTP 200, no 403', async ({ request }) => {
  const res = (await client.callTool({ name: 'tasks_create', arguments: { title: 'denied' } })) as { isError?: boolean; structuredContent?: { error: { code: string } } }
  expect(res.isError).toBe(true)
  expect(res.structuredContent?.error.code).toBe('insufficient_scope')
  const raw = await request.post('/mcp', { headers: { authorization: `Bearer ${provider.saved!.access_token}`, 'content-type': 'application/json' }, data: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'tasks_create', arguments: { title: 'denied' } } } })
  expect(raw.status()).toBe(200)
  expect((await raw.json()).result.isError).toBe(true)
})

test('7. the owner disables the agent and the client\'s next tools/list is 401 with the /mcp challenge', async ({ page, request }) => {
  await setupClerkTestingToken({ context: page.context() })
  await page.goto('/connect')
  await clerk.loaded({ page })
  await clerk.signIn({ page, emailAddress: users.owner.email })
  await page.goto('/connect')
  const owner = await page.evaluate(() => (window as unknown as { Clerk: { session: { getToken(): Promise<string> } } }).Clerk.session.getToken())
  const patched = await request.patch(`/meta/v1/agents/${delegatedAgentId}`, { headers: { authorization: `Bearer ${owner}` }, data: { disabled: true } })
  expect(patched.status()).toBe(200)
  const raw = await request.post('/mcp', { headers: { authorization: `Bearer ${provider.saved!.access_token}`, 'content-type': 'application/json' }, data: { jsonrpc: '2.0', id: 10, method: 'tools/list' } })
  expect(raw.status()).toBe(401)
  expect(raw.headers()['www-authenticate']).toContain('resource_metadata="')
  expect(raw.headers()['www-authenticate']).toContain('oauth-protected-resource/mcp", scope="')
  // The SDK client's own next call fails too: it may refresh, but the same (client, person) agent stays disabled.
  await expect(client.listTools()).rejects.toThrow()
  expect(sql(`select disabled_at from agents where id = '${delegatedAgentId}'`)[0]!.disabled_at).not.toBeNull()
})

