// Test-only. The golden scenarios of [[CORE35]] D17: what a client does to `tasks`, with the actor, the
// injected clock and the expected references spelled out. Runners turn each scenario into a transcript;
// the committed fixtures are those transcripts. No secrets and no tenant data: every id is a fixed constant.

/** Fixed principals and organisation of every scenario. The foreign pair exists on Postgres only (one organisation per D1). */
export const IDS = {
  org: '0190b2c4-0000-7000-8000-00000000a001',
  user: '0190b2c4-0000-7000-8000-00000000b001',
  user2: '0190b2c4-0000-7000-8000-00000000b002',
  agent: '0190b2c4-0000-7000-8000-00000000c001',
  foreignOrg: '0190b2c4-0000-7000-8000-00000000a002',
  foreignUser: '0190b2c4-0000-7000-8000-00000000b003',
  /** The fixed memberships of `user` (owner) and `user2` (member) in `org` (CORE40 P12). */
  membership: '0190b2c4-0000-7000-8000-00000000d001',
  membership2: '0190b2c4-0000-7000-8000-00000000d002',
  missing: '0190b2c4-0000-7000-8000-00000000dead',
  /** The fixed API keys of `agent` (CORE41 P15): one valid, one expired at seed time. */
  agentKey: '0190b2c4-0000-7000-8000-00000000e001',
  expiredKey: '0190b2c4-0000-7000-8000-00000000e002',
} as const

/** The deployment's provider link: the local organisation is `('clerk', GOLDEN_ORG_LINK)` on both engines; the foreign one (Postgres only) is `GOLDEN_FOREIGN_LINK`. */
export const GOLDEN_ORG_LINK = 'org_golden'
export const GOLDEN_FOREIGN_LINK = 'org_golden_foreign'
/** The login subjects of the two seeded users. */
export const GOLDEN_SUBJECTS = { user: 'user_golden_1', user2: 'user_golden_2' } as const
/** The fixed secrets of the seeded keys. They are test constants, never real credentials. */
export const GOLDEN_AGENT_KEY = 'vk_golden-agent-key-0001-fixed-for-fixtures'
export const GOLDEN_EXPIRED_KEY = 'vk_golden-agent-key-0002-expired-at-seed'

/**
 * Who sends a step. `user` and `agent` are injected principals (the alg:none stand-in token); `agent-key` and `expired-key` present the
 * seeded API keys; `{ clerk }` is a real Clerk-signed token for that subject (with an optional organisation claim); `webhook` is a
 * Svix-signed delivery of the step's `body` to `POST /webhooks/clerk` (CORE41 P15).
 */
export type GoldenActor = 'user' | 'agent' | 'agent-key' | 'expired-key' | 'webhook' | { clerk: string; claim?: { org: string; role: string } }
/** The fake Clerk a scenario runs against: profiles by subject and organisations with their members (role `org:admin` or `org:member`). */
export interface GoldenClerk {
  users?: ReadonlyArray<{ subject: string; email: string | null; first?: string | null; last?: string | null; verified?: boolean }>
  organizations?: ReadonlyArray<{ id: string; name: string; members: ReadonlyArray<readonly [string, 'org:admin' | 'org:member']> }>
}
export interface GoldenStep {
  as: GoldenActor
  /** The injected clock for this request (ISO, UTC). */
  at: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** `{name}` is replaced by the id saved under `name` by an earlier step. */
  path: string
  /** A body may reference saved ids the same way, as `"{name}"` string values. */
  body?: unknown
  /** Saves the response body's `id` under this name. */
  save?: string
}
export interface GoldenScenario {
  name: string
  /** Why the scenario exists: the old behaviour it pins. */
  about: string
  /** Loaded into the fake Clerk before the first step. */
  clerk?: GoldenClerk
  /** Seeds the agent's two fixed API keys (`IDS.agentKey`, `IDS.expiredKey`). Off by default so the older fixtures, which list keys, stay byte-identical. */
  keys?: true
  steps: readonly GoldenStep[]
}

const T0 = Date.parse('2026-10-22T09:00:00.000Z')
/** The n-th minute after the scenario clock origin. */
export const at = (n: number): string => new Date(T0 + n * 60_000).toISOString()
/** The n-th second after the scenario clock origin. */
export const secs = (n: number): string => new Date(T0 + n * 1000).toISOString()

export const taskScenarios: readonly GoldenScenario[] = [
  {
    name: 'create-and-read',
    about: 'a minimal create answers 201 with defaults; get, list and the created event agree',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/tasks', body: { title: 'First' }, save: 'a' },
      { as: 'user', at: at(1), method: 'GET', path: '/api/v1/tasks/{a}' },
      { as: 'user', at: at(2), method: 'GET', path: '/api/v1/tasks' },
    ],
  },
  {
    name: 'create-full-and-done',
    about: 'every writable field on create; an offset due_at is stored as UTC; status done stamps completed_at',
    steps: [
      {
        as: 'user',
        at: at(0),
        method: 'POST',
        path: '/api/v1/tasks',
        body: { title: '  Padded title  ', notes: 'n', status: 'done', due_at: '2026-10-25T10:00:00+02:00', assignee_id: IDS.user2 },
        save: 'a',
      },
      { as: 'agent', at: at(1), method: 'POST', path: '/api/v1/tasks', body: { title: 'By the agent', status: 'open', notes: null, due_at: null, assignee_id: null }, save: 'b' },
    ],
  },
  {
    name: 'create-validation',
    about: 'unknown, empty, mistyped and system-owned fields are refused with validation_error and write nothing',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/tasks', body: {} },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/tasks', body: { title: '' } },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/tasks', body: { title: 'x', completed_at: '2026-10-22T09:00:00Z' } },
      { as: 'user', at: at(3), method: 'POST', path: '/api/v1/tasks', body: { title: 'x', due_at: '2026-10-25' } },
      { as: 'user', at: at(4), method: 'POST', path: '/api/v1/tasks', body: { title: 'x', status: 'blocked' } },
      { as: 'user', at: at(5), method: 'POST', path: '/api/v1/tasks', body: { title: 'x', assignee_id: 'not-a-uuid' } },
      { as: 'user', at: at(6), method: 'GET', path: '/api/v1/tasks' },
    ],
  },
  {
    name: 'completion',
    about: 'completed_at follows status: open to done stamps, done to done keeps, done to open clears, no status leaves it',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/tasks', body: { title: 'Complete me' }, save: 'a' },
      { as: 'user', at: at(1), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { status: 'done' } },
      { as: 'user', at: at(2), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { status: 'done', notes: 'again' } },
      { as: 'user', at: at(3), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { title: 'Renamed while done' } },
      { as: 'user', at: at(4), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { status: 'open' } },
      { as: 'user', at: at(5), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { status: 'open' } },
      { as: 'agent', at: at(6), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { status: 'done' } },
    ],
  },
  {
    name: 'patch-variants',
    about: 'an empty patch checks existence and writes nothing; a same-value patch is a real update; null clears nullable fields',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/tasks', body: { title: 'Patch me', notes: 'keep', due_at: '2026-10-30T12:00:00Z', assignee_id: IDS.user2 }, save: 'a' },
      { as: 'user', at: at(1), method: 'PATCH', path: '/api/v1/tasks/{a}', body: {} },
      { as: 'user', at: at(2), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { title: 'Patch me' } },
      { as: 'user', at: at(3), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { notes: null, due_at: null, assignee_id: null } },
      { as: 'user', at: at(4), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { title: 'x', zz_unknown: 1 } },
      { as: 'user', at: at(5), method: 'PATCH', path: `/api/v1/tasks/${IDS.missing}`, body: {} },
      { as: 'user', at: at(6), method: 'PATCH', path: '/api/v1/tasks/not-a-uuid', body: { title: 'x' } },
    ],
  },
  {
    name: 'references',
    about: 'an assignee must be a principal of this vault; checked after existence, before any write; null is always fine',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/tasks', body: { title: 'Assign me' }, save: 'a' },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/tasks', body: { title: 'Bad assignee', assignee_id: IDS.missing } },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/tasks', body: { title: 'Foreign assignee', assignee_id: IDS.foreignUser } },
      { as: 'user', at: at(3), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { assignee_id: IDS.missing } },
      { as: 'user', at: at(4), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { assignee_id: IDS.foreignUser, title: 'Not applied' } },
      { as: 'user', at: at(5), method: 'PATCH', path: `/api/v1/tasks/${IDS.missing}`, body: { assignee_id: IDS.missing } },
      { as: 'user', at: at(6), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { assignee_id: IDS.agent } },
      { as: 'user', at: at(7), method: 'GET', path: '/api/v1/tasks/{a}' },
    ],
  },
  {
    name: 'delete',
    about: 'delete is soft: the record leaves get, list and update; a second delete is not_found; the event carries the last record',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/tasks', body: { title: 'Delete me' }, save: 'a' },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/tasks', body: { title: 'Keep me' }, save: 'b' },
      { as: 'agent', at: at(2), method: 'DELETE', path: '/api/v1/tasks/{a}' },
      { as: 'user', at: at(3), method: 'GET', path: '/api/v1/tasks/{a}' },
      { as: 'user', at: at(4), method: 'PATCH', path: '/api/v1/tasks/{a}', body: { title: 'x' } },
      { as: 'user', at: at(5), method: 'DELETE', path: '/api/v1/tasks/{a}' },
      { as: 'user', at: at(6), method: 'DELETE', path: '/api/v1/tasks/not-a-uuid' },
      { as: 'user', at: at(7), method: 'GET', path: '/api/v1/tasks' },
    ],
  },
  {
    name: 'list-filters-and-pages',
    about: 'filters are equality, pages are id-ordered with an opaque next_cursor, bad filters and limits are validation errors',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/tasks', body: { title: 't1', assignee_id: IDS.user2 }, save: 't1' },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/tasks', body: { title: 't2', status: 'done' }, save: 't2' },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/tasks', body: { title: 't3', assignee_id: IDS.user2, status: 'done' }, save: 't3' },
      { as: 'user', at: at(3), method: 'POST', path: '/api/v1/tasks', body: { title: 't4' }, save: 't4' },
      { as: 'user', at: at(4), method: 'GET', path: '/api/v1/tasks?limit=2' },
      { as: 'user', at: at(5), method: 'GET', path: '/api/v1/tasks?limit=2&after={t2}' },
      { as: 'user', at: at(6), method: 'GET', path: '/api/v1/tasks?status=done' },
      { as: 'user', at: at(7), method: 'GET', path: `/api/v1/tasks?assignee_id=${IDS.user2}&status=done` },
      { as: 'user', at: at(8), method: 'GET', path: '/api/v1/tasks?status=blocked' },
      { as: 'user', at: at(9), method: 'GET', path: '/api/v1/tasks?limit=0' },
      { as: 'user', at: at(10), method: 'GET', path: '/api/v1/tasks?limit=201' },
      { as: 'user', at: at(11), method: 'GET', path: '/api/v1/tasks?after=nope' },
      { as: 'user', at: at(12), method: 'GET', path: '/api/v1/tasks?title=t1' },
    ],
  },
]

// ---- CORE36: the identity model (companies, contacts, identities, resolve, merge, both cascades) -----------------
// No foreign organisation appears anywhere: D1 replays these exactly.
export const identityModelScenarios: readonly GoldenScenario[] = [
  {
    name: 'companies-crud',
    about:
      'domains are normalised and unique per live company (409 domain_exists names the other company); a company may keep its own domain; the domain filter normalises; a deleted company frees its domain',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/companies', body: { name: 'Acme', domain: ' Acme.COM ' }, save: 'a' },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/companies', body: { name: 'Other', domain: 'other.com' }, save: 'b' },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/companies', body: { name: 'Clash', domain: 'ACME.com' } },
      { as: 'user', at: at(3), method: 'PATCH', path: '/api/v1/companies/{b}', body: { domain: 'acme.com' } },
      { as: 'user', at: at(4), method: 'PATCH', path: '/api/v1/companies/{a}', body: { domain: 'ACME.COM', name: 'Acme Inc' } },
      { as: 'user', at: at(5), method: 'POST', path: '/api/v1/companies', body: { name: 'Bad', domain: 'https://acme.com' } },
      { as: 'agent', at: at(6), method: 'POST', path: '/api/v1/companies', body: { name: 'No domain' }, save: 'c' },
      { as: 'user', at: at(7), method: 'GET', path: '/api/v1/companies?domain=ACME.com' },
      { as: 'user', at: at(8), method: 'PATCH', path: '/api/v1/companies/{c}', body: { domain: null, name: 'Renamed' } },
      { as: 'user', at: at(9), method: 'DELETE', path: '/api/v1/companies/{a}' },
      { as: 'user', at: at(10), method: 'POST', path: '/api/v1/companies', body: { name: 'Acme again', domain: 'acme.com' } },
      { as: 'user', at: at(11), method: 'GET', path: '/api/v1/companies/{a}' },
      { as: 'user', at: at(12), method: 'GET', path: '/api/v1/companies' },
    ],
  },
  {
    name: 'company-delete-unlinks',
    about: 'deleting a company unlinks its LIVE contacts in one set (company.deleted, then contact.updated per contact in id order); a deleted contact is untouched',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/companies', body: { name: 'Acme', domain: 'acme.com' }, save: 'co' },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/contacts', body: { name: 'One', company_id: '{co}' }, save: 'k1' },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/contacts', body: { name: 'Two', company_id: '{co}' }, save: 'k2' },
      { as: 'user', at: at(3), method: 'POST', path: '/api/v1/contacts', body: { name: 'Gone', company_id: '{co}' }, save: 'k3' },
      { as: 'user', at: at(4), method: 'DELETE', path: '/api/v1/contacts/{k3}' },
      { as: 'agent', at: at(5), method: 'DELETE', path: '/api/v1/companies/{co}' },
      { as: 'user', at: at(6), method: 'GET', path: '/api/v1/contacts/{k1}' },
      { as: 'user', at: at(7), method: 'GET', path: '/api/v1/contacts?company_id={co}' },
      { as: 'user', at: at(8), method: 'DELETE', path: '/api/v1/companies/{co}' },
    ],
  },
  {
    name: 'contacts-crud',
    about:
      'a contact may be empty; its company must be a live company of this organisation (invalid_reference otherwise); merged_into_id is not writable; the company_id filter lists members',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/contacts', body: {}, save: 'a' },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/companies', body: { name: 'Acme' }, save: 'co' },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/contacts', body: { name: '  Padded  ', company_id: '{co}' }, save: 'b' },
      { as: 'user', at: at(3), method: 'POST', path: '/api/v1/contacts', body: { company_id: IDS.missing } },
      { as: 'user', at: at(4), method: 'PATCH', path: '/api/v1/contacts/{a}', body: { company_id: IDS.missing } },
      { as: 'user', at: at(5), method: 'PATCH', path: '/api/v1/contacts/{a}', body: { merged_into_id: '{b}' } },
      { as: 'agent', at: at(6), method: 'PATCH', path: '/api/v1/contacts/{a}', body: { name: 'Named', company_id: '{co}' } },
      { as: 'user', at: at(7), method: 'PATCH', path: '/api/v1/contacts/{b}', body: {} },
      { as: 'user', at: at(8), method: 'PATCH', path: '/api/v1/contacts/{b}', body: { name: null, company_id: null } },
      { as: 'user', at: at(9), method: 'GET', path: '/api/v1/contacts?company_id={co}' },
      { as: 'user', at: at(10), method: 'DELETE', path: '/api/v1/companies/{co}' },
      { as: 'user', at: at(11), method: 'POST', path: '/api/v1/contacts', body: { company_id: '{co}' } },
      { as: 'user', at: at(12), method: 'GET', path: '/api/v1/contacts' },
    ],
  },
  {
    name: 'contact-delete-cascade',
    about: 'deleting a contact tombstones its live identities in one set (contact.deleted, then identity.deleted per identity in id order); the addresses become reusable',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/contacts', body: { name: 'Ori' }, save: 'k' },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'ori@example.com', contact_id: '{k}' }, save: 'i1' },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/identities', body: { kind: 'phone', value: '+14155550100', contact_id: '{k}' }, save: 'i2' },
      { as: 'user', at: at(3), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'old@example.com', contact_id: '{k}' }, save: 'i3' },
      { as: 'user', at: at(4), method: 'DELETE', path: '/api/v1/identities/{i3}' },
      { as: 'agent', at: at(5), method: 'DELETE', path: '/api/v1/contacts/{k}' },
      { as: 'user', at: at(6), method: 'GET', path: '/api/v1/identities/{i1}' },
      { as: 'user', at: at(7), method: 'POST', path: '/api/v1/contacts', body: {}, save: 'k2' },
      { as: 'user', at: at(8), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'ORI@example.com', contact_id: '{k2}' } },
      { as: 'user', at: at(9), method: 'DELETE', path: '/api/v1/contacts/{k}' },
    ],
  },
  {
    name: 'identities-crud',
    about:
      'exactly one of contact_id or own: true; the value is normalised; a live address is unique (identity_exists names the contact or says own); kind and value are immutable; an empty patch writes nothing; filters',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/contacts', body: { name: 'X' }, save: 'x' },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/contacts', body: { name: 'Y' }, save: 'y' },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: ' Ori@Example.com ', contact_id: '{x}' }, save: 'i' },
      { as: 'user', at: at(3), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'me@us.com', own: true }, save: 'own' },
      { as: 'user', at: at(4), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'a@b.com' } },
      { as: 'user', at: at(5), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'a@b.com', contact_id: '{x}', own: true } },
      { as: 'user', at: at(6), method: 'POST', path: '/api/v1/identities', body: { kind: 'phone', value: '020 7946 0958', contact_id: '{x}' } },
      { as: 'user', at: at(7), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'ORI@example.com', contact_id: '{y}' } },
      { as: 'user', at: at(8), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'me@us.com', contact_id: '{y}' } },
      { as: 'user', at: at(9), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'z@z.com', contact_id: IDS.missing } },
      { as: 'user', at: at(10), method: 'PATCH', path: '/api/v1/identities/{i}', body: { contact_id: '{y}' } },
      { as: 'user', at: at(11), method: 'PATCH', path: '/api/v1/identities/{i}', body: { own: true } },
      { as: 'agent', at: at(12), method: 'PATCH', path: '/api/v1/identities/{i}', body: { contact_id: '{x}' } },
      { as: 'user', at: at(13), method: 'PATCH', path: '/api/v1/identities/{i}', body: {} },
      { as: 'user', at: at(14), method: 'PATCH', path: '/api/v1/identities/{i}', body: { contact_id: '{x}', own: true } },
      { as: 'user', at: at(15), method: 'PATCH', path: '/api/v1/identities/{i}', body: { value: 'other@example.com' } },
      { as: 'user', at: at(16), method: 'GET', path: '/api/v1/identities?kind=email&value=Ori%40Example.COM' },
      { as: 'user', at: at(17), method: 'GET', path: '/api/v1/identities?value=ori@example.com' },
      { as: 'user', at: at(18), method: 'GET', path: '/api/v1/identities?own=true' },
      { as: 'user', at: at(19), method: 'GET', path: '/api/v1/identities?contact_id={x}' },
      { as: 'user', at: at(20), method: 'DELETE', path: '/api/v1/identities/{i}' },
    ],
  },
  {
    name: 'identities-ascii',
    about: 'emails are lowercase ASCII on both engines (D7): a non-ASCII address is invalid_identity before any write, in create, resolve (with its index) and the value filter; phones are unaffected',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/contacts', body: {}, save: 'k' },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'Jürgen@Example.com', contact_id: '{k}' } },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'ö', contact_id: '{k}' } },
      { as: 'user', at: at(3), method: 'POST', path: '/api/v1/identities/resolve', body: { identities: [{ kind: 'email', value: 'ok@example.com' }, { kind: 'email', value: 'bücher@example.com' }] } },
      { as: 'user', at: at(4), method: 'GET', path: '/api/v1/identities?kind=email&value=jürgen@example.com' },
      { as: 'user', at: at(5), method: 'POST', path: '/api/v1/identities', body: { kind: 'phone', value: '+44 20 7946 0958', contact_id: '{k}' } },
      { as: 'user', at: at(6), method: 'GET', path: '/api/v1/identities' },
    ],
  },
  {
    name: 'resolve',
    about:
      'resolve creates one contact and identity per new normalised address in first-occurrence order (events: every contact.created, then every identity.created); existing addresses are never renamed; an own address has no contact; an invalid entry fails the whole call',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/identities/resolve', body: { identities: [{ kind: 'email', value: ' Ori@Example.com ', name: '  Ori  ' }] } },
      {
        as: 'agent',
        at: at(1),
        method: 'POST',
        path: '/api/v1/identities/resolve',
        body: {
          identities: [
            { kind: 'email', value: 'new@example.com' },
            { kind: 'email', value: 'ORI@example.com', name: 'Renamed?' },
            { kind: 'phone', value: '+44 20 7946 0958', name: 'Phone' },
            { kind: 'email', value: 'NEW@example.com', name: 'Again' },
          ],
        },
      },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'me@us.com', own: true } },
      { as: 'user', at: at(3), method: 'POST', path: '/api/v1/identities/resolve', body: { identities: [{ kind: 'email', value: 'me@us.com' }] } },
      { as: 'user', at: at(4), method: 'POST', path: '/api/v1/identities/resolve', body: { identities: [{ kind: 'email', value: 'fine@example.com' }, { kind: 'phone', value: 'abc' }] } },
      { as: 'user', at: at(5), method: 'POST', path: '/api/v1/identities/resolve', body: { identities: [] } },
      { as: 'user', at: at(6), method: 'GET', path: '/api/v1/contacts' },
    ],
  },
  {
    name: 'merge',
    about:
      'merge moves the live identities (identity.updated per identity), fills the survivor empty fields without overwriting (contact.updated), tombstones the source (contact.merged, never contact.deleted); self-merge, unknown and already merged sources are refused',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/api/v1/companies', body: { name: 'Acme' }, save: 'co' },
      { as: 'user', at: at(1), method: 'POST', path: '/api/v1/contacts', body: { name: 'Survivor' }, save: 's' },
      { as: 'user', at: at(2), method: 'POST', path: '/api/v1/contacts', body: { company_id: '{co}' }, save: 'r' },
      { as: 'user', at: at(3), method: 'POST', path: '/api/v1/contacts', body: { name: 'Third' }, save: 't' },
      { as: 'user', at: at(4), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'r1@example.com', contact_id: '{r}' }, save: 'i1' },
      { as: 'user', at: at(5), method: 'POST', path: '/api/v1/identities', body: { kind: 'email', value: 'r2@example.com', contact_id: '{r}' }, save: 'i2' },
      { as: 'user', at: at(6), method: 'DELETE', path: '/api/v1/identities/{i2}' },
      { as: 'user', at: at(7), method: 'POST', path: '/api/v1/contacts/{s}/merge', body: { source_id: '{s}' } },
      { as: 'user', at: at(8), method: 'POST', path: '/api/v1/contacts/{s}/merge', body: { source_id: IDS.missing } },
      { as: 'agent', at: at(9), method: 'POST', path: '/api/v1/contacts/{s}/merge', body: { source_id: '{r}' } },
      { as: 'user', at: at(10), method: 'GET', path: '/api/v1/contacts/{r}' },
      { as: 'user', at: at(11), method: 'GET', path: '/api/v1/identities?contact_id={s}' },
      { as: 'user', at: at(12), method: 'POST', path: '/api/v1/contacts/{t}/merge', body: { source_id: '{r}' } },
      { as: 'user', at: at(13), method: 'POST', path: '/api/v1/contacts/{t}/merge', body: { source_id: '{s}' } },
      { as: 'user', at: at(14), method: 'GET', path: '/api/v1/identities?contact_id={t}' },
    ],
  },
]

// ---- administration (CORE40 D12, P12): agents, api keys, memberships, users ------------------------------------------
export const administrationScenarios: readonly GoldenScenario[] = [
  {
    name: 'agents-crud',
    about:
      'an agent is created with its principal, normalised scopes (trimmed name, deduplicated and sorted scopes); get and list read it; a rename and a scope change are updates; disabling twice keeps the first disabled_at; enabling clears it; an empty patch writes nothing',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/meta/v1/agents', body: { name: '  Bot  ', scopes: ['tasks:write', 'tasks:read', 'tasks:write'] }, save: 'a' },
      { as: 'user', at: at(1), method: 'GET', path: '/meta/v1/agents/{a}' },
      { as: 'user', at: at(2), method: 'GET', path: '/meta/v1/agents' },
      { as: 'user', at: at(3), method: 'PATCH', path: '/meta/v1/agents/{a}', body: { name: 'Renamed' } },
      { as: 'user', at: at(4), method: 'PATCH', path: '/meta/v1/agents/{a}', body: { scopes: ['contacts:read', 'tasks:read'] } },
      { as: 'user', at: at(5), method: 'PATCH', path: '/meta/v1/agents/{a}', body: { disabled: true } },
      { as: 'user', at: at(6), method: 'PATCH', path: '/meta/v1/agents/{a}', body: { disabled: true } },
      { as: 'user', at: at(7), method: 'PATCH', path: '/meta/v1/agents/{a}', body: { disabled: false } },
      { as: 'user', at: at(8), method: 'PATCH', path: '/meta/v1/agents/{a}', body: {} },
      { as: 'user', at: at(9), method: 'POST', path: '/meta/v1/agents', body: { name: 'Bare' } },
    ],
  },
  {
    name: 'agents-refusals',
    about:
      'an unknown scope is unknown_scope and a human-only scope is scope_not_grantable (the first offender in input order decides, on create and on update); a blank name and an unknown field are validation errors; an unknown agent is 404; nothing is written for any of them',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/meta/v1/agents', body: { name: 'Bot' }, save: 'a' },
      { as: 'user', at: at(1), method: 'POST', path: '/meta/v1/agents', body: { name: 'X', scopes: ['tasks:read', 'nope:read'] } },
      { as: 'user', at: at(2), method: 'POST', path: '/meta/v1/agents', body: { name: 'X', scopes: ['members:read', 'nope:read'] } },
      { as: 'user', at: at(3), method: 'POST', path: '/meta/v1/agents', body: { name: '   ' } },
      { as: 'user', at: at(4), method: 'POST', path: '/meta/v1/agents', body: { name: 'X', organization_id: IDS.org } },
      { as: 'user', at: at(5), method: 'PATCH', path: '/meta/v1/agents/{a}', body: { scopes: ['agents:write'] } },
      { as: 'user', at: at(6), method: 'PATCH', path: '/meta/v1/agents/{a}', body: { zz: 1 } },
      { as: 'user', at: at(7), method: 'PATCH', path: `/meta/v1/agents/${IDS.missing}`, body: { name: 'Y' } },
      { as: 'user', at: at(8), method: 'GET', path: '/meta/v1/agents/nope' },
    ],
  },
  {
    name: 'api-keys-issue-revoke',
    about:
      'a key is issued once with its plaintext (vk_ + prefix of 11 characters), the event and every read carry neither the plaintext nor the hash; list filters by agent; revoke stamps revoked_at and updated_at with the unit clock and emits api_key.revoked; revoking again returns the same record with no event; a disabled agent may be issued a key',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/meta/v1/agents', body: { name: 'Bot', scopes: ['tasks:read'] }, save: 'a' },
      { as: 'user', at: at(1), method: 'POST', path: '/meta/v1/api-keys', body: { agent_id: '{a}' }, save: 'k' },
      { as: 'user', at: at(2), method: 'POST', path: '/meta/v1/api-keys', body: { agent_id: '{a}', expires_at: '2027-01-01T00:00:00.000Z' }, save: 'k2' },
      { as: 'user', at: at(3), method: 'GET', path: '/meta/v1/api-keys?agent_id={a}' },
      { as: 'user', at: at(4), method: 'GET', path: '/meta/v1/api-keys/{k}' },
      { as: 'user', at: at(5), method: 'POST', path: '/meta/v1/api-keys/{k}/revoke' },
      { as: 'user', at: at(6), method: 'POST', path: '/meta/v1/api-keys/{k}/revoke' },
      { as: 'user', at: at(7), method: 'GET', path: '/meta/v1/api-keys/{k}' },
      { as: 'user', at: at(8), method: 'PATCH', path: '/meta/v1/agents/{a}', body: { disabled: true } },
      { as: 'user', at: at(9), method: 'POST', path: '/meta/v1/api-keys', body: { agent_id: '{a}' } },
      { as: 'user', at: at(10), method: 'GET', path: '/meta/v1/api-keys' },
    ],
  },
  {
    name: 'api-keys-refusals',
    about:
      'a key for an unknown agent is invalid_reference; an expiry at or before the unit clock is a validation error; an unknown key cannot be revoked (404); an unknown field is refused; nothing is written for any of them',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/meta/v1/agents', body: { name: 'Bot' }, save: 'a' },
      { as: 'user', at: at(1), method: 'POST', path: '/meta/v1/api-keys', body: { agent_id: IDS.missing } },
      { as: 'user', at: at(2), method: 'POST', path: '/meta/v1/api-keys', body: { agent_id: '{a}', expires_at: at(1) } },
      { as: 'user', at: at(3), method: 'POST', path: '/meta/v1/api-keys', body: { agent_id: '{a}', expires_at: at(3) } },
      { as: 'user', at: at(4), method: 'POST', path: '/meta/v1/api-keys', body: { agent_id: '{a}', key: 'vk_mine' } },
      { as: 'user', at: at(5), method: 'POST', path: `/meta/v1/api-keys/${IDS.missing}/revoke` },
      { as: 'user', at: at(6), method: 'POST', path: '/meta/v1/api-keys/nope/revoke' },
      { as: 'user', at: at(7), method: 'GET', path: '/meta/v1/api-keys' },
    ],
  },
  {
    name: 'memberships-read',
    about: 'memberships are read-only: list, the role and user_id filters, get; an unknown id is 404; there is no write route',
    steps: [
      { as: 'user', at: at(0), method: 'GET', path: '/meta/v1/memberships' },
      { as: 'user', at: at(1), method: 'GET', path: '/meta/v1/memberships?role=owner' },
      { as: 'user', at: at(2), method: 'GET', path: `/meta/v1/memberships?user_id=${IDS.user2}` },
      { as: 'user', at: at(3), method: 'GET', path: `/meta/v1/memberships/${IDS.membership2}` },
      { as: 'user', at: at(4), method: 'GET', path: `/meta/v1/memberships/${IDS.missing}` },
      { as: 'user', at: at(5), method: 'PATCH', path: `/meta/v1/memberships/${IDS.membership2}`, body: { role: 'owner' } },
      { as: 'user', at: at(6), method: 'DELETE', path: `/meta/v1/memberships/${IDS.membership2}` },
    ],
  },
  {
    name: 'users-read',
    about: 'users are listed (live members only, keyset by id) and read by id; an unknown id and an id that is not a UUID are 404; a pagination step shows the cursor',
    steps: [
      { as: 'user', at: at(0), method: 'GET', path: '/meta/v1/users' },
      { as: 'user', at: at(1), method: 'GET', path: '/meta/v1/users?limit=1' },
      { as: 'user', at: at(2), method: 'GET', path: `/meta/v1/users?limit=1&after=${IDS.user}` },
      { as: 'user', at: at(3), method: 'GET', path: `/meta/v1/users/${IDS.user2}` },
      { as: 'user', at: at(4), method: 'GET', path: `/meta/v1/users/${IDS.missing}` },
      { as: 'user', at: at(5), method: 'GET', path: '/meta/v1/users/nope' },
    ],
  },
]


const DELIVERY = (type: string, data: unknown) => ({ type, object: 'event', data, timestamp: T0 })
const MEMBERSHIP_DELIVERY = (type: string, org: string, userId: string) => DELIVERY(type, { id: `orgmem_${userId}`, organization: { id: org }, public_user_data: { user_id: userId } })

export const authScenarios: readonly GoldenScenario[] = [
  {
    name: 'api-key-auth',
    keys: true,
    about: 'a seeded key authenticates; last_used_at is stamped at most once a minute (30 s and exactly 60 s later: no stamp; 61 s later: stamped) and updated_at never moves',
    steps: [
      { as: 'agent-key', at: secs(0), method: 'GET', path: `/meta/v1/api-keys/${IDS.agentKey}` },
      { as: 'agent-key', at: secs(30), method: 'GET', path: `/meta/v1/api-keys/${IDS.agentKey}` },
      { as: 'agent-key', at: secs(60), method: 'GET', path: `/meta/v1/api-keys/${IDS.agentKey}` },
      { as: 'agent-key', at: secs(61), method: 'GET', path: `/meta/v1/api-keys/${IDS.agentKey}` },
    ],
  },
  {
    name: 'api-key-refusals',
    keys: true,
    about: 'a revoked key and a key that expired before the request are both 401 with the shared message',
    steps: [
      { as: 'agent-key', at: at(0), method: 'GET', path: '/api/v1/tasks' },
      { as: 'user', at: at(1), method: 'POST', path: `/meta/v1/api-keys/${IDS.agentKey}/revoke` },
      { as: 'agent-key', at: at(2), method: 'GET', path: '/api/v1/tasks' },
      { as: 'expired-key', at: at(3), method: 'GET', path: '/api/v1/tasks' },
    ],
  },
  {
    name: 'first-sight-and-me',
    about: 'the first sight of a subject provisions it with no event (the email is normalised); a second call writes nothing; a seeded user reads /me with its organisation',
    clerk: { users: [{ subject: 'user_golden_new', email: ' Grace@Golden.Test ', first: 'Grace', last: 'Hopper', verified: true }] },
    steps: [
      { as: { clerk: 'user_golden_new' }, at: at(0), method: 'GET', path: '/meta/v1/me' },
      { as: { clerk: 'user_golden_new' }, at: at(1), method: 'GET', path: '/meta/v1/me' },
      { as: { clerk: GOLDEN_SUBJECTS.user, claim: { org: GOLDEN_ORG_LINK, role: 'org:admin' } }, at: at(2), method: 'GET', path: '/meta/v1/me' },
    ],
  },
  {
    name: 'first-sight-refusals',
    about: 'an email that belongs to another user (any case) is 409 account_conflict, a non-ASCII email is 400 invalid_identity, a profile with no email is 401; none writes anything',
    clerk: {
      users: [
        { subject: 'user_golden_dup', email: 'B002@Golden.TEST' },
        { subject: 'user_golden_ascii', email: 'ñandú@golden.test' },
        { subject: 'user_golden_noemail', email: null },
      ],
    },
    steps: [
      { as: { clerk: 'user_golden_dup' }, at: at(0), method: 'GET', path: '/meta/v1/me' },
      { as: { clerk: 'user_golden_ascii' }, at: at(1), method: 'GET', path: '/meta/v1/me' },
      { as: { clerk: 'user_golden_noemail' }, at: at(2), method: 'GET', path: '/meta/v1/me' },
      { as: 'user', at: at(3), method: 'GET', path: '/meta/v1/users' },
    ],
  },
  {
    name: 'claim-repair',
    about: 'a token claiming an organisation the user has no membership in repairs the copy: membership.created by the system principal, then the tenant call succeeds; the next sign-in writes nothing',
    clerk: {
      users: [{ subject: 'user_golden_claim', email: 'claim@golden.test', first: 'Claire', last: 'Claim' }],
      organizations: [{ id: GOLDEN_ORG_LINK, name: 'Golden org', members: [] }],
    },
    steps: [
      { as: { clerk: 'user_golden_claim', claim: { org: GOLDEN_ORG_LINK, role: 'org:member' } }, at: at(0), method: 'GET', path: '/api/v1/tasks' },
      { as: 'user', at: at(1), method: 'GET', path: '/meta/v1/memberships' },
      { as: { clerk: 'user_golden_claim', claim: { org: GOLDEN_ORG_LINK, role: 'org:member' } }, at: at(2), method: 'GET', path: '/api/v1/tasks' },
    ],
  },
  {
    name: 'foreign-organisation-claim',
    about: 'a token claiming another provider organisation: Postgres is multi-tenant and repairs it (200); a D1 serves one organisation and refuses it 403 before any SQL (CORE36 D19, the one named difference)',
    clerk: {
      users: [{ subject: 'user_golden_foreigner', email: 'foreigner@golden.test' }],
      organizations: [{ id: GOLDEN_FOREIGN_LINK, name: 'Foreign org', members: [] }],
    },
    steps: [{ as: { clerk: 'user_golden_foreigner', claim: { org: GOLDEN_FOREIGN_LINK, role: 'org:admin' } }, at: at(0), method: 'GET', path: '/api/v1/tasks' }],
  },
]

export const directoryScenarios: readonly GoldenScenario[] = [
  {
    name: 'webhook-reconcile',
    about: 'one delivery creates a member, re-roles another and removes a third; the same delivery again changes nothing',
    clerk: {
      users: [
        { subject: 'user_golden_claim', email: 'claim@golden.test' },
        { subject: 'user_golden_added', email: 'added@golden.test', first: 'Ada', last: 'Added' },
      ],
      organizations: [
        {
          id: GOLDEN_ORG_LINK,
          name: 'Golden a001', // the seeded name: only the memberships change
          // user_golden_claim is left out: the delivery removes the membership the first step repairs into existence.
          members: [[GOLDEN_SUBJECTS.user, 'org:admin'], [GOLDEN_SUBJECTS.user2, 'org:admin'], ['user_golden_added', 'org:member']],
        },
      ],
    },
    steps: [
      { as: { clerk: 'user_golden_claim', claim: { org: GOLDEN_ORG_LINK, role: 'org:member' } }, at: at(0), method: 'GET', path: '/api/v1/tasks' },
      { as: 'webhook', at: at(1), method: 'POST', path: '/webhooks/clerk', body: MEMBERSHIP_DELIVERY('organizationMembership.updated', GOLDEN_ORG_LINK, 'user_golden_added') },
      { as: 'webhook', at: at(2), method: 'POST', path: '/webhooks/clerk', body: MEMBERSHIP_DELIVERY('organizationMembership.updated', GOLDEN_ORG_LINK, 'user_golden_added') },
      { as: 'user', at: at(3), method: 'GET', path: '/meta/v1/memberships' },
      { as: 'user', at: at(4), method: 'GET', path: '/meta/v1/users' },
    ],
  },
  {
    name: 'webhook-rename',
    about: 'a rename at the provider updates the organisation and emits organization.updated; nothing else changes',
    clerk: {
      organizations: [{ id: GOLDEN_ORG_LINK, name: 'Golden org renamed', members: [[GOLDEN_SUBJECTS.user, 'org:admin'], [GOLDEN_SUBJECTS.user2, 'org:member']] }],
    },
    steps: [{ as: 'webhook', at: at(0), method: 'POST', path: '/webhooks/clerk', body: DELIVERY('organization.updated', { id: GOLDEN_ORG_LINK }) }],
  },
  {
    name: 'webhook-user-updated',
    about: 'user.updated refreshes a known user\'s profile (updated_at is the step clock, no event); an unknown subject costs no provider call',
    clerk: { users: [{ subject: GOLDEN_SUBJECTS.user, email: 'Ada.Lovelace@Golden.Test', first: 'Ada', last: 'Lovelace', verified: true }] },
    steps: [
      { as: 'webhook', at: at(0), method: 'POST', path: '/webhooks/clerk', body: DELIVERY('user.updated', { id: GOLDEN_SUBJECTS.user }) },
      { as: 'user', at: at(1), method: 'GET', path: `/meta/v1/users/${IDS.user}` },
      { as: 'webhook', at: at(2), method: 'POST', path: '/webhooks/clerk', body: DELIVERY('user.updated', { id: 'user_golden_nobody' }) },
    ],
  },
]
