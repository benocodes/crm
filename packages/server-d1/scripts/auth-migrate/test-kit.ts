// Fakes for the auth migration's read side ([[OPS365]]): a Clerk Backend API served from a response recorded on the Clerk dev instance, and a wrangler that answers
// `d1 execute` and `d1 time-travel info` from a world of rows. Both record every call, so a test can say what was (not) reached.
import { readFileSync } from 'node:fs'
import type { D1Like } from '@vibase/storage-d1'
import { seedDeployment, seedPrincipal } from '@vibase/storage-d1/test/seed'
import type { Cmd } from '../remote.js'
import { classify } from './classify.js'
import { exportClerkUsers } from './clerk-export.js'
import { AGENTS_SQL, MEMBERSHIPS_SQL, USERS_SQL, readCrmExport } from './crm-export.js'
import type { AgentRow, AuthPlan, ClerkUserRow, MembershipRow, Snapshot, UserRow } from './types.js'

/** The recorded Clerk response (`GET /v1/users`, scrubbed): four users, one with two addresses whose primary is the second, roles owner, member, agent and none. */
export const recordedClerkUsers = (): Array<Record<string, any>> =>
  JSON.parse(readFileSync(new URL('../fixtures/clerk-users.json', import.meta.url), 'utf8'))

export const CLERK_SECRET = 'sk_test_THIS_VALUE_MUST_NEVER_BE_PRINTED_0123456789'
export const KEY_HASH = 'keyhash_0123456789abcdef0123456789abcdef'

/** A user shaped like a recorded one: the recorded entry with its ids and address replaced. */
export function clerkUserLike(
  base: Record<string, any>,
  id: string,
  email: string,
  role?: string,
): Record<string, any> {
  const u = structuredClone(base)
  const addr = {
    ...u.email_addresses.find((e: any) => e.id === u.primary_email_address_id),
    id: `idn_${id}`,
    email_address: email,
  }
  u.id = id
  u.primary_email_address_id = addr.id
  u.email_addresses = [addr]
  u.public_metadata = role === undefined ? {} : { vibase_role: role }
  return u
}

export interface ClerkCall {
  method: string
  url: string
  authorization: string | null
}
/** A fake `fetch` for the Clerk Backend API: `GET /v1/users?limit&offset&order_by`, the page size capped at `cap` as the real API caps at 500. Any other request is a 500 and is recorded. */
export function fakeClerk(users: Array<Record<string, any>>, cap = 2) {
  const calls: ClerkCall[] = []
  const fetchFn = (async (input: any, init?: any) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ method: init?.method ?? 'GET', url, authorization: headers.get('authorization') })
    const u = new URL(url)
    if ((init?.method ?? 'GET') !== 'GET' || u.pathname !== '/v1/users')
      return new Response('unexpected', { status: 500 })
    const limit = Math.min(Number(u.searchParams.get('limit') ?? '10'), cap)
    const offset = Number(u.searchParams.get('offset') ?? '0')
    return new Response(JSON.stringify(users.slice(offset, offset + limit)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fetch: fetchFn, calls }
}

export interface World {
  users: UserRow[]
  agents: AgentRow[]
  memberships: MembershipRow[]
}
const asDb = (r: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(r).map(([k, v]) => [
      k,
      typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) ? JSON.stringify(v) : v,
    ]),
  )

/** A fake wrangler: `d1 execute` answers by the table the SELECT names, `d1 time-travel info <name>` by the database name. Everything it is asked is in `cmds`. */
export function fakeWrangler(world: World, bookmarks: Record<string, string>) {
  const cmds: Cmd[] = []
  const exec = (cmd: Cmd): { status: number | null; stdout: string } => {
    cmds.push(cmd)
    const a = cmd.args
    const i = a.indexOf('time-travel')
    if (i >= 0) {
      const name = a[i + 2]!
      const bookmark = bookmarks[name]
      return bookmark ? { status: 0, stdout: JSON.stringify({ bookmark }, null, 2) } : { status: 1, stdout: '' }
    }
    if (a.includes('execute')) {
      const sql = a[a.indexOf('--command') + 1] ?? ''
      const table = /\bfrom\s+(\w+)/i.exec(sql)?.[1]
      const rows =
        table === 'users'
          ? world.users
          : table === 'agents'
            ? world.agents
            : table === 'memberships'
              ? world.memberships
              : null
      return rows
        ? { status: 0, stdout: JSON.stringify([{ results: rows.map(asDb), success: true }]) }
        : { status: 1, stdout: '' }
    }
    return { status: 1, stdout: '' }
  }
  return { exec, cmds }
}

const U = (n: number) => `0190aaaa-0000-7000-8000-${String(n).padStart(12, '0')}`
const A = (n: number) => `0190bbbb-0000-7000-8000-${String(n).padStart(12, '0')}`
export const ids = { U, A }

/** Clerk: the four recorded users (a owner, b member, c agent, d no role) plus e (a member nobody in the vault knows) and f (a member who an agent row points at). */
export function standardClerk(): Array<Record<string, any>> {
  const [a, b, c, d] = recordedClerkUsers() as [any, any, any, any]
  return [
    a,
    b,
    c,
    d,
    clerkUserLike(a, 'user_scrubbede', 'e@example.test', 'member'),
    clerkUserLike(a, 'user_scrubbedf', 'f@example.test', 'member'),
  ]
}

const user = (n: number, email: string, subject: string | null, extra: Partial<UserRow> = {}): UserRow => ({
  id: U(n),
  email,
  name: null,
  auth_provider: subject ? 'clerk' : null,
  auth_subject: subject,
  email_verified: true,
  ...extra,
})
const agent = (n: number, name: string, extra: Partial<AgentRow> = {}): AgentRow => ({
  id: A(n),
  name,
  scopes: ['contacts:read'],
  disabled_at: null,
  auth_provider: null,
  auth_subject: null,
  auth_client_id: null,
  delegated_by: null,
  ...extra,
})
const DISABLED = '2026-11-01T00:00:00.000Z'

/** The vault: u1 owner (matches Clerk a), u2 member (b), u3 (d, Clerk holds no role), u4 vault-only (its Clerk user is gone), u5 no provider at all. */
export function standardWorld(): World {
  return {
    users: [
      user(1, 'a@example.test', 'user_scrubbeda'),
      user(2, 'b@example.test', 'user_scrubbedb'),
      user(3, 'd@example.test', 'user_scrubbedd'),
      user(4, 'gone@example.test', 'user_gone'),
      user(5, 'nolink@example.test', null),
    ],
    memberships: [
      { id: U(101), user_id: U(1), role: 'owner', deleted_at: null },
      { id: U(102), user_id: U(2), role: 'member', deleted_at: null },
      { id: U(103), user_id: U(4), role: 'member', deleted_at: '2026-10-01T00:00:00.000Z' },
    ],
    agents: [
      agent(1, 'plain key'),
      agent(2, 'account', { auth_provider: 'clerk', auth_subject: 'user_scrubbedc' }),
      agent(3, 'delegated', {
        auth_provider: 'clerk',
        auth_client_id: 'client_x',
        delegated_by: U(1),
        scopes: ['contacts:read', 'notes:write'],
      }),
      agent(4, 'plain key, disabled', { disabled_at: DISABLED }),
      agent(5, 'account, disabled', { auth_provider: 'clerk', auth_subject: 'user_scrubbedc2', disabled_at: DISABLED }),
      agent(6, 'delegated, disabled', {
        auth_provider: 'clerk',
        auth_client_id: 'client_y',
        delegated_by: U(2),
        disabled_at: DISABLED,
      }),
      agent(7, 'account, Clerk user gone', { auth_provider: 'clerk', auth_subject: 'user_vanished' }),
      agent(8, 'account, Clerk user is a member', { auth_provider: 'clerk', auth_subject: 'user_scrubbedf' }),
    ],
  }
}

// ---- the apply side ([[OPS392]]): a vault seeded into a local D1 from a World, and the plan made from it ----

export const ORG_ID = '0190dddd-0000-7000-8000-000000000001'

/** The CRM rows of a World written into a migrated local D1: the deployment and its organisation, then principals, users, memberships and agents (the agents' every column). */
export async function seedWorld(d1: D1Like, world: World): Promise<void> {
  await seedDeployment(d1, { organizationId: ORG_ID, provider: 'clerk', externalId: 'org_hq' })
  for (const u of world.users)
    await seedPrincipal(d1, {
      id: u.id,
      kind: 'user',
      email: u.email,
      name: u.name,
      ...(u.auth_subject ? { authProvider: u.auth_provider ?? 'clerk', authSubject: u.auth_subject } : {}),
      emailVerified: u.email_verified,
    })
  const creator = world.users[0]?.id ?? U(1)
  for (const m of world.memberships)
    await d1
      .prepare(
        'INSERT INTO memberships (id, created_at, updated_at, organization_id, user_id, role, created_by, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(m.id, SEEDED_AT, SEEDED_AT, ORG_ID, m.user_id, m.role, creator, m.deleted_at)
      .run()
  for (const a of world.agents)
    await d1.batch([
      d1.prepare("INSERT INTO principals (id, kind, created_at) VALUES (?, 'agent', ?)").bind(a.id, SEEDED_AT),
      d1
        .prepare(
          'INSERT INTO agents (id, created_at, updated_at, organization_id, name, scopes, disabled_at, created_by, auth_provider, auth_subject, auth_client_id, delegated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          a.id,
          SEEDED_AT,
          SEEDED_AT,
          ORG_ID,
          a.name,
          JSON.stringify(a.scopes),
          a.disabled_at,
          creator,
          a.auth_provider,
          a.auth_subject,
          a.auth_client_id,
          a.delegated_by,
        ),
    ])
}
export const SEEDED_AT = '2026-10-22T08:00:00.000Z'

/** Clerk bodies as the real export normalizes them. */
export async function clerkRowsOf(bodies: Array<Record<string, any>>): Promise<ClerkUserRow[]> {
  return exportClerkUsers({ secretKey: CLERK_SECRET, fetch: fakeClerk(bodies, 500).fetch })
}

/** The normalized export of what a local D1 holds now, through the real CRM reader (its three SELECTs answered from the database) beside the given Clerk users. */
export async function readSnapshot(d1: D1Like, clerk_users: ClerkUserRow[]): Promise<Snapshot> {
  const answers = new Map<string, string>()
  for (const sql of [USERS_SQL, AGENTS_SQL, MEMBERSHIPS_SQL])
    answers.set(sql, JSON.stringify([{ results: (await d1.prepare(sql).all()).results, success: true }]))
  return { clerk_users: structuredClone(clerk_users), ...readCrmExport((sql) => answers.get(sql)!) }
}

/** The plan classify makes from a snapshot, with sequential new ids (`0190cccc-...`). */
export function planOf(snapshot: Snapshot, idStart = 0): AuthPlan {
  let n = idStart
  return {
    version: 1,
    env: 'hq',
    created_at: '2026-11-16T12:00:00.000Z',
    crm: { database_name: 'vault-crm-hq', database_id: 'crm-id', bookmark: 'B1' },
    control: { database_name: 'vault-control-hq', database_id: 'ctl-id', bookmark: 'B2' },
    ...classify(snapshot, () => `0190cccc-0000-7000-8000-${String(++n).padStart(12, '0')}`),
    snapshot,
  }
}
