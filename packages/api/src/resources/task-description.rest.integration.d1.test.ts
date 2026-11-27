import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { mintTestUserToken } from '../test/user-auth.js'

// [[CORE680]] D5: a task's free text is `description` on every surface, and `notes` is just an unknown field (no alias, no special error).
const registry = createVibaseRegistry()
let k: ActionKit
let owner: Actor
beforeAll(async () => {
  k = await openActionKit({ registry })
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  owner = k.as(k.owner, registry.declaredScopes())
})

const mcp = async (method: string, params: unknown) =>
  (await (
    await k.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mintTestUserToken({ userId: owner.id, organizationId: k.organizationId, scopes: registry.declaredScopes(), kind: 'user' })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  ).json()) as any
const make = async (body: Record<string, unknown>) => {
  const r = await k.call(owner, 'POST', '/api/v1/tasks', body)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body
}

describe('every surface carries description (REST)', () => {
  it('create and update write it, get and list return it, never a notes key', async () => {
    const t = await make({ title: 'A', description: 'first words' })
    expect(t.description).toBe('first words')
    expect('notes' in t).toBe(false)
    const up = await k.call(owner, 'PATCH', `/api/v1/tasks/${t.id}`, { description: 'second words' })
    expect(up.status).toBe(200)
    expect(up.body.description).toBe('second words')
    const got = await k.call(owner, 'GET', `/api/v1/tasks/${t.id}`)
    expect(got.body.description).toBe('second words')
    expect('notes' in got.body).toBe(false)
    const list = await k.call(owner, 'GET', '/api/v1/tasks')
    expect(list.body.data[0].description).toBe('second words')
    expect('notes' in list.body.data[0]).toBe(false)
  })
  it('a list filter and group_by on description work', async () => {
    await make({ title: 'A', description: 'x' })
    await make({ title: 'B', description: 'y' })
    await make({ title: 'C', description: 'x' })
    const f = await k.call(owner, 'GET', '/api/v1/tasks?description=eq.x')
    expect(f.status, JSON.stringify(f.body)).toBe(200)
    expect(f.body.data.map((r: any) => r.title).sort()).toEqual(['A', 'C'])
    const a = await k.call(owner, 'GET', '/api/v1/tasks/aggregate?group_by=description')
    expect(a.status, JSON.stringify(a.body)).toBe(200)
    expect(JSON.stringify(a.body)).toContain('"x"')
  })
  it('schema_get lists description on tasks and not notes', async () => {
    const doc = (await k.call(owner, 'GET', '/meta/v1/schema')).body
    const tasks = doc.tables.find((t: any) => t.name === 'tasks')
    const cols = tasks.columns.map((c: any) => c.name)
    expect(cols).toContain('description')
    expect(cols).not.toContain('notes')
    const filters = tasks.resource.filters.map((f: any) => f.name)
    expect(filters).toContain('description')
    expect(filters).not.toContain('notes')
    expect(tasks.resource.aggregate.group_by).toContain('description')
  })
})

describe('every surface carries description (MCP)', () => {
  it('create, update, get and list name description, and the tool schemas have no notes', async () => {
    const tools = (await mcp('tools/list', {})).result.tools as any[]
    for (const n of ['tasks_create', 'tasks_update']) {
      const props = Object.keys(tools.find((t) => t.name === n).inputSchema.properties)
      expect(props, n).toContain('description')
      expect(props, n).not.toContain('notes')
    }
    const created = await mcp('tools/call', { name: 'tasks_create', arguments: { title: 'M', description: 'via mcp' } })
    expect(created.result.isError).not.toBe(true)
    const id = created.result.structuredContent.id
    const upd = await mcp('tools/call', { name: 'tasks_update', arguments: { id, description: 'changed' } })
    expect(upd.result.structuredContent.description).toBe('changed')
    const got = await mcp('tools/call', { name: 'tasks_get', arguments: { id } })
    expect(got.result.structuredContent.description).toBe('changed')
    const list = await mcp('tools/call', { name: 'tasks_list', arguments: { description: 'eq.changed' } })
    expect(list.result.structuredContent.data.map((r: any) => r.id)).toEqual([id])
  })
})

describe('notes on a task is an unknown field, like any other', () => {
  const answer = (r: { status: number; body: any }) => {
    const m = JSON.stringify(r.body?.error?.message ?? '')
    return { status: r.status, code: r.body?.error?.code, message: m }
  }
  const same = (a: { status: number; body: any }, b: { status: number; body: any }) => {
    const x = answer(a)
    const y = answer(b)
    expect(x.status).toBe(y.status)
    expect(x.code).toBe(y.code)
    expect(x.message.replaceAll('notes', 'bogus_field')).toBe(y.message)
  }
  it('create', async () => {
    same(
      await k.call(owner, 'POST', '/api/v1/tasks', { title: 'x', notes: 'a' }),
      await k.call(owner, 'POST', '/api/v1/tasks', { title: 'x', bogus_field: 'a' }),
    )
    expect(await k.rows('tasks')).toEqual([]) // refused, or ignored the same way, but never stored as a description
  })
  it('update', async () => {
    const t = await make({ title: 'x', description: 'keep' })
    same(
      await k.call(owner, 'PATCH', `/api/v1/tasks/${t.id}`, { notes: 'a' }),
      await k.call(owner, 'PATCH', `/api/v1/tasks/${t.id}`, { bogus_field: 'a' }),
    )
    expect((await k.call(owner, 'GET', `/api/v1/tasks/${t.id}`)).body.description).toBe('keep')
  })
  it.each([
    ['filter', (n: string) => `/api/v1/tasks?${n}=eq.a`],
    ['sort', (n: string) => `/api/v1/tasks?sort=${n}`],
    ['group_by', (n: string) => `/api/v1/tasks/aggregate?group_by=${n}`],
  ])('%s', async (_name, url) => {
    await make({ title: 'x', description: 'a' })
    same(await k.call(owner, 'GET', url('notes')), await k.call(owner, 'GET', url('bogus_field')))
  })
})

describe('events carry description', () => {
  it('task.created and task.updated have it in after (and before), never a notes key', async () => {
    const t = await make({ title: 'E', description: 'one' })
    await k.call(owner, 'PATCH', `/api/v1/tasks/${t.id}`, { description: 'two' })
    const [created] = await k.events('task.created')
    const [updated] = await k.events('task.updated')
    expect(created!.after).toMatchObject({ description: 'one' })
    expect('notes' in (created!.after as object)).toBe(false)
    expect(updated!.before).toMatchObject({ description: 'one' })
    expect(updated!.after).toMatchObject({ description: 'two' })
    expect('notes' in (updated!.before as object)).toBe(false)
    expect('notes' in (updated!.after as object)).toBe(false)
  })
})
