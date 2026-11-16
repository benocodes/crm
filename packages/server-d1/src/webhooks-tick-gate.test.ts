import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import {
  CONTROL_MIGRATIONS,
  openControlDb,
  writeControlMarker,
  type D1Like,
  type D1PreparedLike,
} from '@vibase/storage-d1'
import { type D1WorkerEnv } from './compose.js'
import { bootstrapD1, NOW, openWorkerPair, type WorkerPair, composeD1Worker } from './test/kit.js'

// CORE337 group 5 (P2): the per-minute tick runs webhook dispatch and the sender only when the request path's control conditions hold (the binding, control migrations current or ahead, the control marker
// paired with the CRM's). Otherwise both are skipped with one line naming the reason, no control query touches a webhook table, no fetch leaves, and the expiry and runner sweeps still run.
let p: WorkerPair
let key: string
let organizationId: string
let fetches: string[] = []
const BASE = 'https://w.test'
const KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')
const SCOPES = [
  'webhooks:read',
  'webhooks:write',
  'events:read',
  'tasks:read',
  'tasks:write',
  'tasks:request_approval',
  'action_requests:read',
]
const hook: typeof fetch = async (input) => {
  fetches.push(String(input))
  return new Response(null, { status: 200 })
}
const at = (ms: number) => new Date(NOW.getTime() + ms)

/** A control database that records every statement it is asked to prepare. */
function recording(real: D1Like): { d1: D1Like; sql: string[] } {
  const sql: string[] = []
  const inners = new WeakMap<object, D1PreparedLike>()
  const wrap = (q: string, inner: D1PreparedLike): D1PreparedLike => {
    const wrapped = {
      bind: (...v: unknown[]) => wrap(q, inner.bind(...v)),
      run: () => inner.run(),
      all: () => inner.all(),
      first: () => inner.first(),
    } as D1PreparedLike
    inners.set(wrapped, inner)
    return wrapped
  }
  return {
    sql,
    d1: {
      prepare: (q: string) => (sql.push(q), wrap(q, real.prepare(q))),
      batch: (b: D1PreparedLike[]) => (
        sql.push(...b.map(() => 'batch statement')), real.batch(b.map((s) => inners.get(s) ?? s))
      ),
    } as D1Like,
  }
}
const worker = (over: Partial<D1WorkerEnv> & { CRON_TICK_BUDGET?: string } = {}, when = NOW) =>
  composeD1Worker(
    { DB: p.d1, CONTROL_DB: p.control, AUTH_PROVIDER: '', CREDENTIALS_KEY: KEY, ...over } as D1WorkerEnv,
    { fetch: hook, clock: () => when, newId: () => uuidv7(when) },
  )
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, body?: unknown) => {
  const res = await wk.fetch(
    new Request(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}
const ctl = async (sqlText: string) =>
  ((await p.control.prepare(sqlText).all()).results ?? []) as Array<Record<string, any>>
const crm = async (sqlText: string) => ((await p.d1.prepare(sqlText).all()).results ?? []) as Array<Record<string, any>>

beforeAll(async () => {
  p = await openWorkerPair()
})
afterAll(() => p.dispose())
beforeEach(async () => {
  await p.reset()
  fetches = []
  // The pending case removes a row of the control tracker; put every migration back.
  for (const m of CONTROL_MIGRATIONS)
    await p.control
      .prepare(
        'insert into d1_migrations (name) select ? where not exists (select 1 from d1_migrations where name = ?)',
      )
      .bind(m.name, m.name)
      .run()
  const res = await bootstrapD1(
    p.d1,
    { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme', scopes: SCOPES },
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(p.control) },
  )
  key = res.key
  organizationId = ((await crm('select organization_id from deployment'))[0] as { organization_id: string })
    .organization_id
})
afterEach(() => vi.restoreAllMocks())

/** A subscription, a task event it would receive and an action request that expires within a minute: what the tick would dispatch, send and sweep. */
async function seed() {
  const wk = worker()
  expect(
    (await call(wk, 'POST', '/meta/v1/webhooks', { url: 'https://example.com/hook', event_types: ['task.created'] }))
      .status,
  ).toBe(201)
  expect((await call(wk, 'POST', '/api/v1/tasks', { title: 'gated' })).status).toBe(201)
  const r = await call(wk, 'POST', '/api/v1/action-requests', {
    operation: 'tasks.create',
    arguments: { title: 't' },
    reason: 'r',
    expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
  })
  expect(r.status).toBe(201)
  return r.body.id as string
}

/** A tick one minute on, composed fresh (an isolate that remembers nothing of the request path's gate). */
async function gatedTick(over: Partial<D1WorkerEnv> = {}) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const recorder = recording(p.control)
  await worker({ CONTROL_DB: recorder.d1, ...over }, at(60_000)).scheduled({ cron: '* * * * *' })
  return { lines: log.mock.calls.map((c) => String(c[0])), recorder }
}
const touchedWebhooks = (sql: string[]) => sql.filter((q) => /webhook_/.test(q) || q === 'batch statement')

describe('the tick gate (P2)', () => {
  const skipped = async (why: string, breakIt: () => Promise<unknown>) => {
    const request = await seed()
    await breakIt()
    const { lines, recorder } = await gatedTick()
    expect(
      lines.filter((l) => l.includes('webhooks skipped')),
      lines.join('\n'),
    ).toEqual([expect.stringContaining(`control plane: ${why}`)])
    expect(touchedWebhooks(recorder.sql), 'no control query touched a webhook table').toEqual([])
    expect(fetches, 'no outbound fetch').toEqual([])
    expect(await ctl('select id from webhook_deliveries'), 'nothing was dispatched').toEqual([])
    // The sweeps still ran: the overdue request expired.
    expect((await crm(`select status from action_requests where id = '${request}'`))[0]!.status).toBe('expired')
  }

  it('control migrations pending: both phases are skipped naming migrations_pending, the sweeps run', async () => {
    await skipped('migrations_pending', () =>
      p.control
        .prepare('delete from d1_migrations where name = ?')
        .bind(CONTROL_MIGRATIONS[CONTROL_MIGRATIONS.length - 1]!.name)
        .run(),
    )
  })

  it('no control marker: both phases are skipped naming not_paired, the sweeps run', async () => {
    await skipped('not_paired', () => p.control.prepare('delete from control_deployment').run())
  })

  it('a marker naming another organisation: both phases are skipped naming not_paired, the sweeps run', async () => {
    await skipped('not_paired', async () => {
      await p.control.prepare('delete from control_deployment').run()
      await writeControlMarker(openControlDb(p.control), uuidv7())
    })
  })

  it('no control binding: both phases are skipped naming no_binding, the sweeps run', async () => {
    const request = await seed()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await composeD1Worker({ DB: p.d1, CONTROL_DB: undefined, AUTH_PROVIDER: '', CREDENTIALS_KEY: KEY } as D1WorkerEnv, {
      fetch: hook,
      clock: () => at(60_000),
      newId: () => uuidv7(at(60_000)),
    }).scheduled({ cron: '* * * * *' })
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.filter((l) => l.includes('webhooks skipped'))).toEqual([
      expect.stringContaining('control plane: no_binding'),
    ])
    expect(fetches).toEqual([])
    expect((await crm(`select status from action_requests where id = '${request}'`))[0]!.status).toBe('expired')
  })

  it('conditions met: dispatch and the sender both run on control (that their queries are spent from the tick budget is pinned by the budget-of-50 case in webhooks-sender.test.ts)', async () => {
    await seed()
    const { lines, recorder } = await gatedTick()
    expect(lines.filter((l) => l.includes('webhooks skipped'))).toEqual([])
    expect(
      lines.some((l) => l.includes('webhooks dispatched 1 event(s) for 1 subscription(s)')),
      lines.join('\n'),
    ).toBe(true)
    expect(
      lines.some((l) => l.includes('webhooks sent 1,')),
      lines.join('\n'),
    ).toBe(true)
    expect(fetches).toEqual(['https://example.com/hook'])
    expect((await ctl('select status from webhook_deliveries')).map((r) => r.status)).toEqual(['delivered'])
    expect(touchedWebhooks(recorder.sql).length).toBeGreaterThan(0)
  })
})
