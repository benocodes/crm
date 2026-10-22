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
  missing: '0190b2c4-0000-7000-8000-00000000dead',
} as const

export const FIXED_IDS: ReadonlySet<string> = new Set(Object.values(IDS))

export type GoldenActor = 'user' | 'agent'
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
  steps: readonly GoldenStep[]
}

const T0 = Date.parse('2026-10-22T09:00:00.000Z')
/** The n-th minute after the scenario clock origin. */
export const at = (n: number): string => new Date(T0 + n * 60_000).toISOString()

export const taskScenarios: readonly GoldenScenario[] = [
  {
    name: 'create-and-read',
    about: 'a minimal create answers 201 with defaults; get, list and the created event agree',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/tasks', body: { title: 'First' }, save: 'a' },
      { as: 'user', at: at(1), method: 'GET', path: '/tasks/{a}' },
      { as: 'user', at: at(2), method: 'GET', path: '/tasks' },
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
        path: '/tasks',
        body: { title: '  Padded title  ', notes: 'n', status: 'done', due_at: '2026-10-25T10:00:00+02:00', assignee_id: IDS.user2 },
        save: 'a',
      },
      { as: 'agent', at: at(1), method: 'POST', path: '/tasks', body: { title: 'By the agent', status: 'open', notes: null, due_at: null, assignee_id: null }, save: 'b' },
    ],
  },
  {
    name: 'create-validation',
    about: 'unknown, empty, mistyped and system-owned fields are refused with validation_error and write nothing',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/tasks', body: {} },
      { as: 'user', at: at(1), method: 'POST', path: '/tasks', body: { title: '' } },
      { as: 'user', at: at(2), method: 'POST', path: '/tasks', body: { title: 'x', completed_at: '2026-10-22T09:00:00Z' } },
      { as: 'user', at: at(3), method: 'POST', path: '/tasks', body: { title: 'x', due_at: '2026-10-25' } },
      { as: 'user', at: at(4), method: 'POST', path: '/tasks', body: { title: 'x', status: 'blocked' } },
      { as: 'user', at: at(5), method: 'POST', path: '/tasks', body: { title: 'x', assignee_id: 'not-a-uuid' } },
      { as: 'user', at: at(6), method: 'GET', path: '/tasks' },
    ],
  },
  {
    name: 'completion',
    about: 'completed_at follows status: open to done stamps, done to done keeps, done to open clears, no status leaves it',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/tasks', body: { title: 'Complete me' }, save: 'a' },
      { as: 'user', at: at(1), method: 'PATCH', path: '/tasks/{a}', body: { status: 'done' } },
      { as: 'user', at: at(2), method: 'PATCH', path: '/tasks/{a}', body: { status: 'done', notes: 'again' } },
      { as: 'user', at: at(3), method: 'PATCH', path: '/tasks/{a}', body: { title: 'Renamed while done' } },
      { as: 'user', at: at(4), method: 'PATCH', path: '/tasks/{a}', body: { status: 'open' } },
      { as: 'user', at: at(5), method: 'PATCH', path: '/tasks/{a}', body: { status: 'open' } },
      { as: 'agent', at: at(6), method: 'PATCH', path: '/tasks/{a}', body: { status: 'done' } },
    ],
  },
  {
    name: 'patch-variants',
    about: 'an empty patch checks existence and writes nothing; a same-value patch is a real update; null clears nullable fields',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/tasks', body: { title: 'Patch me', notes: 'keep', due_at: '2026-10-30T12:00:00Z', assignee_id: IDS.user2 }, save: 'a' },
      { as: 'user', at: at(1), method: 'PATCH', path: '/tasks/{a}', body: {} },
      { as: 'user', at: at(2), method: 'PATCH', path: '/tasks/{a}', body: { title: 'Patch me' } },
      { as: 'user', at: at(3), method: 'PATCH', path: '/tasks/{a}', body: { notes: null, due_at: null, assignee_id: null } },
      { as: 'user', at: at(4), method: 'PATCH', path: '/tasks/{a}', body: { title: 'x', zz_unknown: 1 } },
      { as: 'user', at: at(5), method: 'PATCH', path: `/tasks/${IDS.missing}`, body: {} },
      { as: 'user', at: at(6), method: 'PATCH', path: '/tasks/not-a-uuid', body: { title: 'x' } },
    ],
  },
  {
    name: 'references',
    about: 'an assignee must be a principal of this vault; checked after existence, before any write; null is always fine',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/tasks', body: { title: 'Assign me' }, save: 'a' },
      { as: 'user', at: at(1), method: 'POST', path: '/tasks', body: { title: 'Bad assignee', assignee_id: IDS.missing } },
      { as: 'user', at: at(2), method: 'POST', path: '/tasks', body: { title: 'Foreign assignee', assignee_id: IDS.foreignUser } },
      { as: 'user', at: at(3), method: 'PATCH', path: '/tasks/{a}', body: { assignee_id: IDS.missing } },
      { as: 'user', at: at(4), method: 'PATCH', path: '/tasks/{a}', body: { assignee_id: IDS.foreignUser, title: 'Not applied' } },
      { as: 'user', at: at(5), method: 'PATCH', path: `/tasks/${IDS.missing}`, body: { assignee_id: IDS.missing } },
      { as: 'user', at: at(6), method: 'PATCH', path: '/tasks/{a}', body: { assignee_id: IDS.agent } },
      { as: 'user', at: at(7), method: 'GET', path: '/tasks/{a}' },
    ],
  },
  {
    name: 'delete',
    about: 'delete is soft: the record leaves get, list and update; a second delete is not_found; the event carries the last record',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/tasks', body: { title: 'Delete me' }, save: 'a' },
      { as: 'user', at: at(1), method: 'POST', path: '/tasks', body: { title: 'Keep me' }, save: 'b' },
      { as: 'agent', at: at(2), method: 'DELETE', path: '/tasks/{a}' },
      { as: 'user', at: at(3), method: 'GET', path: '/tasks/{a}' },
      { as: 'user', at: at(4), method: 'PATCH', path: '/tasks/{a}', body: { title: 'x' } },
      { as: 'user', at: at(5), method: 'DELETE', path: '/tasks/{a}' },
      { as: 'user', at: at(6), method: 'DELETE', path: '/tasks/not-a-uuid' },
      { as: 'user', at: at(7), method: 'GET', path: '/tasks' },
    ],
  },
  {
    name: 'list-filters-and-pages',
    about: 'filters are equality, pages are id-ordered with an opaque next_cursor, bad filters and limits are validation errors',
    steps: [
      { as: 'user', at: at(0), method: 'POST', path: '/tasks', body: { title: 't1', assignee_id: IDS.user2 }, save: 't1' },
      { as: 'user', at: at(1), method: 'POST', path: '/tasks', body: { title: 't2', status: 'done' }, save: 't2' },
      { as: 'user', at: at(2), method: 'POST', path: '/tasks', body: { title: 't3', assignee_id: IDS.user2, status: 'done' }, save: 't3' },
      { as: 'user', at: at(3), method: 'POST', path: '/tasks', body: { title: 't4' }, save: 't4' },
      { as: 'user', at: at(4), method: 'GET', path: '/tasks?limit=2' },
      { as: 'user', at: at(5), method: 'GET', path: '/tasks?limit=2&after={t2}' },
      { as: 'user', at: at(6), method: 'GET', path: '/tasks?status=done' },
      { as: 'user', at: at(7), method: 'GET', path: `/tasks?assignee_id=${IDS.user2}&status=done` },
      { as: 'user', at: at(8), method: 'GET', path: '/tasks?status=blocked' },
      { as: 'user', at: at(9), method: 'GET', path: '/tasks?limit=0' },
      { as: 'user', at: at(10), method: 'GET', path: '/tasks?limit=201' },
      { as: 'user', at: at(11), method: 'GET', path: '/tasks?after=nope' },
      { as: 'user', at: at(12), method: 'GET', path: '/tasks?title=t1' },
    ],
  },
]
