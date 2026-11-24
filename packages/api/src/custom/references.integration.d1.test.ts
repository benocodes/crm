import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { PROJECTS_KEY, PROJECTS_REFS, createCustomTables, projectsRefsDefinition } from '../test/custom-objects.js'

// [[CORE541]] D21, D22, P1, P3, P4: references and unique fields of a custom object, on D1 through the real app. The reference matrix, the commit guard and the approval guard (invariant 9), the unique plan
// read, its drift answer, and the DDL the declaration produces. The action kit gives the clock-free app, the raw D1 and one hook between a unit's plan reads and its commit.
const registry = createVibaseRegistry({ definitions: [projectsRefsDefinition()] })
const ALL = registry.declaredScopes()
const PATH = `/api/v1/${PROJECTS_KEY}`
const AR = '/api/v1/action-requests'
const MISSING = '0190b2c4-0000-7000-8000-00000000dead'
let k: ActionKit
let owner: Actor
beforeAll(async () => {
  k = await openActionKit({ registry })
  await createCustomTables(k.d1, PROJECTS_KEY, PROJECTS_REFS)
})
afterAll(() => k.close())
beforeEach(async () => {
  // Custom rows reference the core tables, so they go before the harness empties those.
  await k.d1.prepare(`DELETE FROM "${PROJECTS_KEY}"`).run()
  await k.reset()
  owner = k.as(k.owner, ALL)
})

const call = (method: string, path: string, body?: unknown, who: Actor = owner) => k.call(who, method, path, body)
const make = async (body: Record<string, unknown>, who: Actor = owner) => call('POST', PATH, body, who)
const rowsOf = async (sqlText: string, ...binds: unknown[]) =>
  ((
    await k.d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const projectRows = () => rowsOf(`SELECT * FROM "${PROJECTS_KEY}"`)
const code = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]
const eventCount = async (type: string) => (await k.events(type)).length

async function pipelineStage(): Promise<string> {
  const pipeline = (await call('POST', '/meta/v1/pipelines', { name: 'Sales' })).body.id
  return (
    await call('POST', '/meta/v1/pipeline-stages', { pipeline_id: pipeline, name: 'Open', kind: 'open', position: 1 })
  ).body.id
}

/** One target per kind of reference: its field, a live id, and (where it soft-deletes) the id of one that was deleted. */
async function targets(): Promise<
  Record<string, { field: string; live: string; dead: string | null; missing: string }>
> {
  const stage = await pipelineStage()
  const created = async (path: string, body: Record<string, unknown>) => {
    const r = await call('POST', path, body)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return r.body.id as string
  }
  const deleted = async (path: string, body: Record<string, unknown>) => {
    const id = await created(path, body)
    expect((await call('DELETE', `${path}/${id}`)).status).toBe(204)
    return id
  }
  return {
    companies: {
      field: 'company',
      live: await created('/api/v1/companies', { name: 'Acme' }),
      dead: await deleted('/api/v1/companies', { name: 'Gone' }),
      missing: MISSING,
    },
    deals: {
      field: 'deal',
      live: await created('/api/v1/deals', { name: 'Big', stage_id: stage }),
      dead: await deleted('/api/v1/deals', { name: 'Lost', stage_id: stage }),
      missing: MISSING,
    },
    tasks: {
      field: 'task',
      live: await created('/api/v1/tasks', { title: 'Do' }),
      dead: await deleted('/api/v1/tasks', { title: 'Done' }),
      missing: MISSING,
    },
    principals: { field: 'owner', live: owner.id, dead: null, missing: MISSING },
    [PROJECTS_KEY]: {
      field: 'parent',
      live: (await make({ name: 'parent' })).body.id,
      dead: await deleted(PATH, { name: 'dead parent' }),
      missing: MISSING,
    },
  }
}

describe('D21: the DDL of a reference and of a unique field (P1)', () => {
  it('a reference carries a single-column foreign key to its target with no ON DELETE', async () => {
    const fks = await rowsOf(`SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)`, PROJECTS_KEY)
    const own = fks.filter((f) => !['organization_id', 'created_by'].includes(f.from))
    expect(own.map((f) => [f.from, f.table, f.to, f.on_delete]).sort()).toEqual(
      [
        ['company', 'companies', 'id', 'NO ACTION'],
        ['deal', 'deals', 'id', 'NO ACTION'],
        ['owner', 'principals', 'id', 'NO ACTION'],
        ['parent', PROJECTS_KEY, 'id', 'NO ACTION'],
        ['task', 'tasks', 'id', 'NO ACTION'],
      ].sort(),
    )
  })
  it('a reference gets (organization_id, field, id) and a unique field only the partial unique index, and no second one', async () => {
    const indexes = await rowsOf(`SELECT name, "unique", partial FROM pragma_index_list(?)`, PROJECTS_KEY)
    const columnsOf = async (name: string) =>
      (await rowsOf(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`, name)).map((r) => r.name)
    const byShape: Record<string, { unique: number; partial: number }> = {}
    for (const i of indexes)
      byShape[(await columnsOf(i.name as string)).join(',')] = { unique: i.unique, partial: i.partial }
    for (const f of ['owner', 'company', 'deal', 'task', 'parent'])
      expect(byShape[`organization_id,${f},id`], f).toEqual({ unique: 0, partial: 0 })
    for (const f of ['code', 'seq']) {
      expect(byShape[`organization_id,${f}`], f).toEqual({ unique: 1, partial: 1 })
      expect(byShape[`organization_id,${f},id`], `${f} gets no second index`).toBeUndefined()
    }
    const [{ sql: text }] = await rowsOf(`SELECT sql FROM sqlite_master WHERE name = ?`, 'idx_projects__c_code_unique')
    expect(text).toMatch(/WHERE "deleted_at" IS NULL AND "code" IS NOT NULL/)
  })
})

describe('D21 reference live check (the matrix)', () => {
  const kinds = ['companies', 'deals', 'tasks', 'principals', PROJECTS_KEY]
  it.each(kinds)(
    '%s: a missing id and a soft-deleted target are 400 invalid_reference on create and update, nothing written',
    async (target) => {
      const t = (await targets())[target]!
      const existing = (await make({ name: 'existing' })).body.id
      const rows = (await projectRows()).length
      const created = await eventCount(`${PROJECTS_KEY}.created`)
      const updated = await eventCount(`${PROJECTS_KEY}.updated`)
      const bad = [['missing', t.missing] as const, ...(t.dead ? [['deleted', t.dead] as const] : [])]
      for (const [what, id] of bad) {
        expect(code(await make({ name: `x-${what}`, [t.field]: id })), `create ${target} ${what}`).toEqual([
          400,
          'invalid_reference',
        ])
        expect(code(await call('PATCH', `${PATH}/${existing}`, { [t.field]: id })), `update ${target} ${what}`).toEqual(
          [400, 'invalid_reference'],
        )
      }
      expect(await projectRows()).toHaveLength(rows)
      expect(await eventCount(`${PROJECTS_KEY}.created`)).toBe(created)
      expect(await eventCount(`${PROJECTS_KEY}.updated`)).toBe(updated)
      expect((await call('GET', `${PATH}/${existing}`)).body[t.field]).toBeNull()
    },
  )
  it.each(kinds)('%s: a live target is accepted on create and on update, and null clears it', async (target) => {
    const t = (await targets())[target]!
    const created = await make({ name: 'with', [t.field]: t.live })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body[t.field]).toBe(t.live)
    const plain = (await make({ name: 'plain' })).body.id
    const updated = await call('PATCH', `${PATH}/${plain}`, { [t.field]: t.live })
    expect(updated.status, JSON.stringify(updated.body)).toBe(200)
    expect(updated.body[t.field]).toBe(t.live)
    const cleared = await call('PATCH', `${PATH}/${plain}`, { [t.field]: null })
    expect(cleared.body[t.field]).toBeNull()
  })
  it('principals is an existence check, not a live one (P3): a user with no live membership is still a valid target', async () => {
    const who = await k.actor('former', 'agent', ['tasks:read'])
    await k.d1.prepare(`UPDATE agents SET disabled_at = ? WHERE id = ?`).bind('2026-11-01T00:00:00.000Z', who.id).run()
    expect((await make({ name: 'p', owner: who.id })).status).toBe(201)
  })
  it("another organisation's company is not a valid target", async () => {
    const other = '0190b2c4-0000-7000-8000-00000000cafe'
    expect(code(await make({ name: 'x', company: other }))).toEqual([400, 'invalid_reference'])
  })
})

describe('invariant 9: the guard at commit and at approval', () => {
  it('a target soft-deleted between the plan and the commit refuses the write and writes nothing (create and update)', async () => {
    const all = await targets()
    const t = all.companies!
    const existing = (await make({ name: 'existing' })).body.id
    const events = await eventCount(`${PROJECTS_KEY}.created`)
    const rows = (await projectRows()).length
    k.beforeCommit(() =>
      k.d1
        .prepare(`UPDATE companies SET deleted_at = ? WHERE id = ?`)
        .bind('2026-11-06T09:00:00.000Z', t.live)
        .run()
        .then(() => undefined),
    )
    expect(code(await make({ name: 'drift', company: t.live }))).toEqual([409, 'conflict'])
    expect(await projectRows()).toHaveLength(rows)
    expect(await eventCount(`${PROJECTS_KEY}.created`)).toBe(events)
    const t2 = all.tasks!
    k.beforeCommit(() =>
      k.d1
        .prepare(`UPDATE tasks SET deleted_at = ? WHERE id = ?`)
        .bind('2026-11-06T09:00:00.000Z', t2.live)
        .run()
        .then(() => undefined),
    )
    const updatedEvents = await eventCount(`${PROJECTS_KEY}.updated`)
    expect(code(await call('PATCH', `${PATH}/${existing}`, { task: t2.live }))).toEqual([409, 'conflict'])
    expect(await eventCount(`${PROJECTS_KEY}.updated`)).toBe(updatedEvents)
    expect((await call('GET', `${PATH}/${existing}`)).body.task).toBeNull()
  })
  it('a proposal creating a record whose target is deleted before approval is 400 invalid_reference on approve, and nothing is written', async () => {
    const proposer = await k.actor('proposer', 'agent', [
      `${PROJECTS_KEY}:read`,
      `${PROJECTS_KEY}:request_approval`,
      'action_requests:read',
    ])
    const company = (await call('POST', '/api/v1/companies', { name: 'Soon gone' })).body.id
    const proposal = await call(
      'POST',
      AR,
      { operation: `${PROJECTS_KEY}.create`, arguments: { name: 'proposed', company }, reason: 'because' },
      proposer,
    )
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(201)
    expect((await call('DELETE', `/api/v1/companies/${company}`)).status).toBe(204)
    const approved = await call('POST', `${AR}/${proposal.body.id}/approve`)
    expect(code(approved)).toEqual([400, 'invalid_reference'])
    expect(await projectRows()).toEqual([])
    expect(await eventCount(`${PROJECTS_KEY}.created`)).toBe(0)
  })
})

describe('D22: unique fields', () => {
  it('a second live holder of a value is 409 value_exists naming the object, field, value and the existing id; no row, no event', async () => {
    const first = (await make({ name: 'one', code: 'A-1', seq: 7 })).body
    const events = await eventCount(`${PROJECTS_KEY}.created`)
    const dup = await make({ name: 'two', code: 'A-1' })
    expect(code(dup)).toEqual([409, 'value_exists'])
    expect(dup.body.error.message).toContain(PROJECTS_KEY)
    expect(dup.body.error.message).toContain('code')
    expect(dup.body.error.message).toContain('A-1')
    expect(dup.body.error.message).toContain(first.id)
    const dupInt = await make({ name: 'three', seq: 7 })
    expect(code(dupInt)).toEqual([409, 'value_exists'])
    expect(dupInt.body.error.message).toContain(first.id)
    expect(await eventCount(`${PROJECTS_KEY}.created`)).toBe(events)
    expect(await projectRows()).toHaveLength(1)
  })
  it('an update to a held value is 409 value_exists naming the holder; a row keeping its own value updates', async () => {
    const one = (await make({ name: 'one', code: 'A-1' })).body
    const two = (await make({ name: 'two', code: 'B-2' })).body
    const refused = await call('PATCH', `${PATH}/${two.id}`, { code: 'A-1' })
    expect(code(refused)).toEqual([409, 'value_exists'])
    expect(refused.body.error.message).toContain(one.id)
    expect((await call('GET', `${PATH}/${two.id}`)).body.code).toBe('B-2')
    const same = await call('PATCH', `${PATH}/${one.id}`, { code: 'A-1', name: 'renamed' })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    expect(same.body.name).toBe('renamed')
  })
  it('a soft-deleted holder and null values do not collide', async () => {
    const one = (await make({ name: 'one', code: 'A-1' })).body
    expect((await call('DELETE', `${PATH}/${one.id}`)).status).toBe(204)
    expect((await make({ name: 'reuses', code: 'A-1' })).status).toBe(201)
    expect((await make({ name: 'n1' })).status).toBe(201)
    expect((await make({ name: 'n2', code: null })).status).toBe(201)
    expect((await make({ name: 'n3', code: null })).status).toBe(201)
  })
  it('a holder committed after the plan read answers 409 conflict (as the company domain race does), and nothing is written (P4)', async () => {
    const events = await eventCount(`${PROJECTS_KEY}.created`)
    k.beforeCommit(async () => {
      const id = '0190b2c4-0000-7000-8000-0000000000aa'
      await k.d1
        .prepare(
          `INSERT INTO "${PROJECTS_KEY}" (id, organization_id, created_by, created_at, updated_at, name, code) VALUES (?, ?, ?, ?, ?, 'racer', 'R-1')`,
        )
        .bind(id, k.organizationId, k.owner.id, '2026-11-06T09:00:00.000Z', '2026-11-06T09:00:00.000Z')
        .run()
    })
    expect(code(await make({ name: 'late', code: 'R-1' }))).toEqual([409, 'conflict'])
    expect((await projectRows()).map((r) => r.name)).toEqual(['racer'])
    expect(await eventCount(`${PROJECTS_KEY}.created`)).toBe(events)
  })
  it('a proposal approved after the value was taken is 409 value_exists, and nothing is written', async () => {
    const proposer = await k.actor('proposer', 'agent', [
      `${PROJECTS_KEY}:read`,
      `${PROJECTS_KEY}:request_approval`,
      'action_requests:read',
    ])
    const proposal = await call(
      'POST',
      AR,
      { operation: `${PROJECTS_KEY}.create`, arguments: { name: 'proposed', code: 'P-1' }, reason: 'because' },
      proposer,
    )
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(201)
    const holder = (await make({ name: 'holder', code: 'P-1' })).body
    const approved = await call('POST', `${AR}/${proposal.body.id}/approve`)
    expect(code(approved)).toEqual([409, 'value_exists'])
    expect(approved.body.error.message).toContain(holder.id)
    expect((await projectRows()).map((r) => r.name)).toEqual(['holder'])
  })
})
