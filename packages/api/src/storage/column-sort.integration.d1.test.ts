import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compileOperation } from '@vibase/storage'
import { sql } from 'kysely'
import { z } from 'zod'
import { ScopeSet } from '../scopes.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { definePreparedResource, type PreparedResource } from './definition.js'
import { listOperation } from './crud.js'
import { withColumnSorts } from './sorts.js'

const id = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const T1 = '2026-10-01T08:00:00.123Z'
const T2 = '2026-10-02T08:00:00.456Z'
const ASC = [2, 4, 7, 3, 6, 1, 5].map(id)
const record = z.object({ id: z.uuid(), created_at: z.string(), updated_at: z.string(), title: z.string(), notes: z.string().nullable(), due_at: z.string().nullable(), assignee_id: z.uuid().nullable(), moment: z.string().nullable().optional() })
const task = definePreparedResource({
  surface: 'api', name: 'sort_probe', eventName: 'task', table: 'tasks', operations: ['list'], record,
  derived: { moment: { kind: 'timestamp', expression: (_qc, parent) => sql`${parent('due_at')}`, requires: [{ resource: 'interactions', action: 'read' }] } },
})
const attachment = definePreparedResource({
  surface: 'api', name: 'attachment_probe', eventName: 'attachment', table: 'message_attachments', operations: ['list'],
  record: z.object({ id: z.uuid(), created_at: z.string(), size_bytes: z.number().nullable() }),
})
let e: Engine
beforeAll(async () => { e = await openD1Engine() })
afterAll(async () => { await e?.close() })
beforeEach(async () => { await e.reset() })
const env = (extra = false) => e.env({ scopes: ScopeSet.parse(['tasks:read', ...(extra ? ['interactions:read'] : [])]) })
async function seedTasks() {
  const [lo, hi] = [e.userId, e.user2Id].sort()
  for (const n of [6, 1, 4, 3, 7, 5, 2]) {
    const level = [2, 4, 7].includes(n) ? null : [3, 6].includes(n) ? 0 : 1
    await e.insert('tasks', { id: id(n), title: String(n), notes: level === null ? null : level === 0 ? 'Z' : 'a', due_at: level === null ? null : level === 0 ? T1 : T2, assignee_id: level === null ? null : level === 0 ? lo : hi })
  }
}
async function seedAttachments() {
  await e.insert('threads', { id: id(100), channel: 'email', subject: null })
  await e.insert('messages', { id: id(101), thread_id: id(100), channel: 'email', kind: 'message', external_id: 'sort-probe', author: {}, occurred_at: T1, preview: '', content_key: 'sort-probe', version: 1 })
  for (const n of [6, 1, 4, 3, 7, 5, 2]) {
    await e.insert('message_attachments', { id: id(n), message_id: id(101), position: n, type: 'file', size_bytes: [2, 4, 7].includes(n) ? null : [3, 6].includes(n) ? 10 : 20, inline: false, fetch_status: 'pending' })
  }
}
async function walk(def: PreparedResource, sort: string, order: 'asc' | 'desc', limit: number, extra = false) {
  const result: string[] = []
  let after: string | undefined
  for (let guard = 0; guard < 20; guard++) {
    const page = (await e.run(listOperation(def, env(extra), { sort, order, limit, after }))).value
    result.push(...page.data.map((r) => r.id))
    if (page.next_cursor === null) return result
    after = page.next_cursor
  }
  throw new Error('walk did not terminate')
}

describe('generic column walks on D1 (CORE170 D4)', () => {
  for (const [kind, field] of [['timestamp', 'due_at'], ['text', 'notes'], ['uuid', 'assignee_id'], ['integer', 'size_bytes'], ['uuid primary key', 'id']] as const) {
    for (const order of ['asc', 'desc'] as const) {
      it(`${kind} ${order}: small pages cross nulls and ties exactly once`, async () => {
        const def = withColumnSorts(field === 'size_bytes' ? attachment : task, field === 'id' ? [] : [field])
        await (field === 'size_bytes' ? seedAttachments() : seedTasks())
        const asc = field === 'id' ? [1, 2, 3, 4, 5, 6, 7].map(id) : ASC
        const expected = order === 'asc' ? asc : [...asc].reverse()
        for (const limit of [1, 2, 3, 50]) {
          const found = await walk(def, field, order, limit)
          expect(found, `page size ${limit}`).toEqual(expected)
          expect(new Set(found).size).toBe(7)
        }
      })
    }
  }
  it('empty and single row results terminate without cursors', async () => {
    const def = withColumnSorts(task, ['due_at'])
    for (const order of ['asc', 'desc'] as const) expect(await walk(def, 'due_at', order, 1)).toEqual([])
    await e.insertTask({ id: id(1), title: 'alone' })
    for (const order of ['asc', 'desc'] as const) expect(await walk(def, 'due_at', order, 1)).toEqual([id(1)])
  })
  it('sort=id emits one ordering term and one scalar keyset comparison', () => {
    const def = withColumnSorts(task)
    const raw = Buffer.from(JSON.stringify(['id', 'desc', id(3), id(3)])).toString('base64url')
    const read = compileOperation(listOperation(def, env(), { sort: 'id', order: 'desc', after: raw }), 'd1').reads[0]!
    expect(read.sql.slice(read.sql.indexOf('order by'))).toMatch(/^order by "tasks"\."id" desc limit \?$/)
    expect(read.sql).toContain('"tasks"."id" < ?')
    expect(read.sql).not.toContain(' or ')
  })
  it('BINARY ordering overrides a stored NOCASE column in both order and keyset predicates', async () => {
    const def = withColumnSorts(definePreparedResource({
      surface: 'meta', name: 'collation_probe', eventName: 'pipeline', table: 'pipelines', operations: ['list'],
      record: z.object({ id: z.uuid(), created_at: z.string(), updated_at: z.string(), name: z.string() }),
    }), ['name'])
    await e.insert('pipelines', { id: id(1), name: 'a' })
    await e.insert('pipelines', { id: id(2), name: 'Z' })
    expect(await walk(def, 'name', 'asc', 1)).toEqual([id(2), id(1)])
    expect(await walk(def, 'name', 'desc', 1)).toEqual([id(1), id(2)])
  })
  it('uses raw timestamp cursor values when the public projection changes them', async () => {
    await seedTasks()
    const projected = { ...task, record: record.extend({ due_at: z.string().nullable().transform((v) => v === null ? null : 'public-day') }) }
    const def = withColumnSorts(projected, ['due_at'])
    const page = (await e.run(listOperation(def, env(), { sort: 'due_at', order: 'desc', limit: 1 }))).value
    expect(page.data[0]).toMatchObject({ id: id(5), due_at: 'public-day' })
    expect(JSON.parse(Buffer.from(page.next_cursor!, 'base64url').toString())).toEqual(['due_at', 'desc', T2, id(5)])
    expect(await walk(def, 'due_at', 'desc', 1)).toEqual([...ASC].reverse())
    expect(page.data[0]).not.toHaveProperty('__vibase_sort_value')
  })
})

describe('derived compatibility through the column capability (CORE170 D8)', () => {
  it('gates derived sorts before a query while stored columns need only the read scope', async () => {
    const def = withColumnSorts(task, ['moment', 'due_at'])
    expect(() => listOperation(def, env(), { sort: 'moment' })).toThrow(/requires interactions:read/)
    expect(() => listOperation(def, env(), { sort: 'moment', after: 'bad' })).toThrow(/cursor/)
    expect((await e.run(listOperation(def, env(), { sort: 'due_at' }))).value.data).toEqual([])
    await seedTasks()
    for (const order of ['asc', 'desc'] as const) expect(await walk(def, 'moment', order, 1, true)).toEqual(order === 'asc' ? ASC : [...ASC].reverse())
  })
})

describe('mail plan facts on real D1 tables (CORE170 D7)', () => {
  const mail = (table: 'messages' | 'interactions') => withColumnSorts(definePreparedResource({
    surface: 'api', name: 'mail_probe', eventName: 'mail', table, operations: ['list'],
    record: z.object({ id: z.uuid(), created_at: z.string(), occurred_at: z.string() }),
    filters: { thread_id: { schema: z.uuid() } },
  }), ['occurred_at'])
  for (const [table, thread, index] of [['messages', false, 'idx_messages_occurred'], ['messages', true, 'idx_messages_thread_occurred'], ['interactions', false, 'idx_interactions_occurred']] as const) {
    it(`${table} occurred_at ${thread ? 'with thread' : 'plain'} uses ${index}`, async () => {
      for (const order of ['asc', 'desc'] as const) {
        const read = compileOperation(listOperation(mail(table), env(), { sort: 'occurred_at', order, ...(thread ? { filters: { thread_id: id(100) } } : {}) }), 'd1').reads[0]!
        const rows = (await e.d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.parameters).all()).results as Array<{ detail: string }>
        const plan = rows.map((r) => r.detail).join('\n')
        console.info(`${table} ${order} ${thread ? 'thread' : 'plain'}: ${plan}`)
        expect(plan).toContain(index)
        expect(plan).not.toContain('USE TEMP B-TREE')
      }
    })
  }
  for (const table of ['messages', 'interactions'] as const) {
    it(`${table} created_at has the accepted temporary-sort cost`, async () => {
      const read = compileOperation(listOperation(mail(table), env(), { sort: 'created_at', order: 'desc' }), 'd1').reads[0]!
      const rows = (await e.d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.parameters).all()).results as Array<{ detail: string }>
      const plan = rows.map((r) => r.detail).join('\n')
      console.info(`${table} created_at: ${plan}`)
      expect(plan).toContain('USE TEMP B-TREE FOR ORDER BY')
    })
  }
})
