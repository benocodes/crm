import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execute, uuidv7 } from '@vibase/storage'
import { d1Binding } from '@vibase/storage-d1'
import {
  SCOPE_POLICY,
  createVibaseRegistry,
  createWorkspaceAuthAdapter,
  createWorkspaceAuthenticator,
  type ScopePolicy,
} from '@vibase/api'
import { mintClerkToken, mintOAuthToken } from '@vibase/api/test/clerk'
import { initDeploymentOperation } from './init-deployment.js'
import { NOW, clerkKit, clerkUser, openWorkerD1, type ClerkKit, type WorkerD1 } from './test/kit.js'

// [[API518]] group 3 (D3): the workspace authenticator closes every set under `read => read_metadata` before it meets it with another, on each principal it builds. Nothing declares a
// read_metadata scope yet, so the seam passes `contacts:read_metadata` in the declared scopes and the policy. Paths: an agent account (CLI client token), a person (a session, and the CLI
// acting as the person) and a delegated agent (a DCR client's token).
let w: WorkerD1
let kit: ClerkKit
let clock: Date
beforeAll(async () => {
  w = await openWorkerD1()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  kit.fetch.reset()
  kit.profiles.clear()
  kit.clients.clear()
  clock = new Date()
})

const CLI = 'client_cli'
const DCR = 'client_dcr'
const META = 'contacts:read_metadata'
const declared = [...createVibaseRegistry().declaredScopes(), META].sort()
// The metadata scope is agent-grantable but a member's policy has no row for it: a member holds it only through the closure of contacts:read.
const open: ScopePolicy = { ...SCOPE_POLICY, [META]: { member: false, agentGrantable: true } }
/** A policy where a member holds the metadata scope without `contacts:read`. */
const metaOnly: ScopePolicy = {
  ...open,
  [META]: { member: true, agentGrantable: true },
  'contacts:read': { member: false, agentGrantable: true },
}

const rows = async (sqlText: string, ...binds: unknown[]) =>
  (
    await w.d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results as Array<Record<string, any>>
const profile = (sub: string, role: unknown) =>
  kit.profiles.set(sub, clerkUser({ id: sub, email: `${sub}@x.test`, verified: true, role }))

async function setup(policy: ScopePolicy = open, declaredScopes: readonly string[] = declared) {
  const link = { organizationId: uuidv7(NOW), authProvider: 'clerk', authOrgId: kit.issuer.issuer }
  await execute(
    d1Binding(w.d1, link),
    { kind: 'internal', organizationId: link.organizationId },
    initDeploymentOperation(link),
  )
  const at = NOW.toISOString()
  await w.d1
    .prepare(
      'insert into organizations (id, created_at, updated_at, name, auth_provider, auth_org_id) values (?, ?, ?, ?, ?, ?)',
    )
    .bind(link.organizationId, at, at, 'Acme', link.authProvider, link.authOrgId)
    .run()
  const adapter = createWorkspaceAuthAdapter(
    { ...kit.env, CLERK_WEBHOOK_SECRET: undefined } as unknown as Record<string, string | undefined>,
    { fetch: kit.fetch, now: () => clock },
  )!
  const authenticator = createWorkspaceAuthenticator({ adapter, declaredScopes, cliClientId: CLI, policy })
  const storage = d1Binding(w.d1, link)
  const env = { now: clock, newId: () => uuidv7(clock) }
  const authenticate = async (token: string) =>
    (await authenticator.authenticate(token, { storage, organizationHeader: undefined, env })).scopes
  return { authenticate }
}
const oauth = (sub: string, clientId: string, scope: string) =>
  mintOAuthToken(kit.issuer, { sub, clientId, scope, now: clock })
const session = (sub: string, role: string) =>
  mintClerkToken(kit.issuer, { sub, extra: { vibase_role: role }, now: clock })
const setStored = (agentSubjectOrClient: { sub?: string; client?: string }, scopes: string[]) =>
  w.d1
    .prepare(
      agentSubjectOrClient.sub
        ? 'update agents set scopes = ? where auth_subject = ?'
        : 'update agents set scopes = ? where auth_client_id = ?',
    )
    .bind(JSON.stringify(scopes), agentSubjectOrClient.sub ?? agentSubjectOrClient.client)
    .run()
const has = (
  set: { has(s: { resource: string; action: 'read' | 'read_metadata' }): boolean },
  action: 'read' | 'read_metadata',
) => set.has({ resource: 'contacts', action })

describe('an agent account (role agent, CLI client token)', () => {
  const asAccount = async (stored: string[], request: string) => {
    const { authenticate } = await setup()
    profile('user_g', 'agent')
    await authenticate(await oauth('user_g', CLI, 'contacts:read')) // first sight
    await setStored({ sub: 'user_g' }, stored)
    return authenticate(await oauth('user_g', CLI, request))
  }
  it('a holder of contacts:read passes a requirement of contacts:read_metadata', async () => {
    expect(has(await asAccount(['contacts:read'], `contacts:read ${META}`), 'read_metadata')).toBe(true)
  })
  it('a token that requests only contacts:read_metadata from a holder of contacts:read keeps it', async () => {
    const set = await asAccount(['contacts:read'], META)
    expect(set.toStrings()).toEqual([META])
  })
  it('a holder of contacts:read_metadata alone fails a requirement of contacts:read', async () => {
    const set = await asAccount([META], `contacts:read ${META}`)
    expect(has(set, 'read')).toBe(false)
    expect(has(set, 'read_metadata')).toBe(true)
  })
})

describe('a person (session, and the CLI acting as the person)', () => {
  it('a session of a member holding contacts:read passes a requirement of contacts:read_metadata (the role term)', async () => {
    const { authenticate } = await setup()
    profile('user_m', 'member')
    expect(has(await authenticate(await session('user_m', 'member')), 'read_metadata')).toBe(true)
  })
  it('a CLI token that requests only contacts:read_metadata from a holder of contacts:read keeps it', async () => {
    const { authenticate } = await setup()
    profile('user_m', 'member')
    expect((await authenticate(await oauth('user_m', CLI, META))).toStrings()).toEqual([META])
  })
  it('a member holding contacts:read_metadata alone fails a requirement of contacts:read', async () => {
    const { authenticate } = await setup(metaOnly)
    profile('user_m', 'member')
    const set = await authenticate(await oauth('user_m', CLI, `contacts:read ${META}`))
    expect(has(set, 'read')).toBe(false)
    expect(has(set, 'read_metadata')).toBe(true)
  })
})

describe('a delegated agent (a DCR client)', () => {
  const asDelegate = async (stored: string[], request: string, policy: ScopePolicy = open) => {
    const { authenticate } = await setup(policy)
    profile('user_o', 'owner')
    await authenticate(await oauth('user_o', DCR, 'contacts:read')) // first sight
    await setStored({ client: DCR }, stored)
    return authenticate(await oauth('user_o', DCR, request))
  }
  it('a holder of contacts:read passes a requirement of contacts:read_metadata', async () => {
    expect(has(await asDelegate(['contacts:read'], `contacts:read ${META}`), 'read_metadata')).toBe(true)
  })
  it('a token that requests only contacts:read_metadata from a holder of contacts:read keeps it', async () => {
    expect((await asDelegate(['contacts:read'], META)).toStrings()).toEqual([META])
  })
  it('a holder of contacts:read_metadata alone fails a requirement of contacts:read', async () => {
    const set = await asDelegate([META], `contacts:read ${META}`)
    expect(has(set, 'read')).toBe(false)
    expect(has(set, 'read_metadata')).toBe(true)
  })
  it('the stored scopes are never rewritten by the closure', async () => {
    await asDelegate(['contacts:read'], META)
    const [agent] = await rows('select scopes from agents where auth_client_id = ?', DCR)
    expect(JSON.parse(agent!.scopes)).toEqual(['contacts:read'])
  })
})

describe('dormant: the real declared scopes (API518 group 5)', () => {
  it('an OAuth request for messages:read_metadata is dropped like any undeclared scope, from every principal', async () => {
    const real = createVibaseRegistry().declaredScopes()
    expect(real).not.toContain('messages:read_metadata')
    const { authenticate } = await setup(SCOPE_POLICY, real)
    profile('user_o', 'owner')
    const asPerson = await authenticate(await oauth('user_o', CLI, 'messages:read messages:read_metadata'))
    expect(asPerson.toStrings()).toEqual(['messages:read'])
    const asDelegate = await authenticate(await oauth('user_o', DCR, 'messages:read messages:read_metadata'))
    expect(asDelegate.toStrings()).toEqual(['messages:read'])
  })
})
