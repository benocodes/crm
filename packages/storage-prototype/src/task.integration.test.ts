import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { backends, harness, type Harness } from './test/backend.js'
import { exactEvents } from './test/contracts.js'
import { uuid7 } from './uuid7.js'
for (const backend of backends)
  describe(backend, () => {
    let h: Harness
    beforeAll(async () => {
      h = await harness(backend)
    })
    afterAll(async () => {
      await h?.close()
    })
    test('title/notes exact before and after', async () => {
      const before: any = await h.seed()
      await h.clearEvents()
      const r = await h.task(before.id, { title: 'New', notes: 'note' })
      expect(r.value).toMatchObject({
        ...before,
        title: 'New',
        notes: 'note',
        updated_at: expect.any(String),
      })
      await exactEvents(h, r, [{ type: 'task.updated', before, after: r.value }])
    })
    test('empty/equal/completion transitions', async () => {
      const before: any = await h.seed()
      await h.clearEvents()
      const empty = await h.task(before.id, {})
      expect(empty.value).toEqual(before)
      await exactEvents(h, empty, [])
      const done = await h.task(before.id, { status: 'done' })
      expect(done.value.completed_at).toMatch(/Z$/)
      const equal = await h.task(before.id, { status: 'done' })
      expect(equal.value.completed_at).toBe(done.value.completed_at)
      const title = await h.task(before.id, { title: 'Old' })
      expect(title.value.completed_at).toBe(done.value.completed_at)
      const open = await h.task(before.id, { status: 'open' })
      expect(open.value.completed_at).toBeNull()
      expect(await h.events()).toHaveLength(4)
    })
    test('missing empty and nonempty are typed 404 without effects', async () => {
      await h.clearEvents()
      const counts = await h.counts()
      for (const patch of [{}, { title: 'New' }])
        await expect(h.task(uuid7(), patch)).rejects.toMatchObject({ status: 404, code: 'not_found' })
      expect(await h.counts()).toEqual(counts)
    })
    test('agent attribution exact caller and original creator', async () => {
      const before: any = await h.seed()
      await h.clearEvents()
      const r = await h.task(before.id, { title: 'Agent' }, h.agentContext)
      expect(r.value.created_by).toBe(before.created_by)
      expect((await h.events())[0]).toMatchObject({ actor_id: h.agentContext.actor.id, after: r.value })
    })
    test('deleted targets and forged attribution leave no changes', async () => {
      const row: any = await h.seed()
      const tombstone = new Date().toISOString()
      if (backend === 'postgres') {
        const { withContext, deleteResource, tasks } = await import('@vault/api')
        await withContext((h as any).db, h.a, (c) => deleteResource(c, tasks, row.id))
      } else await h.query('UPDATE tasks SET deleted_at=? WHERE id=?', [tombstone, row.id])
      await h.clearEvents()
      const before = await h.query('SELECT * FROM tasks')
      const counts = await h.counts()
      for (const patch of [{}, { title: 'No' }])
        await expect(h.task(row.id, patch)).rejects.toMatchObject({ status: 404, code: 'not_found' })
      await expect(
        h.task(row.id, { organization_id: h.b.organizationId, actor_id: h.b.actor.id }),
      ).rejects.toMatchObject({ status: 400, code: 'validation_error' })
      expect(await h.query('SELECT * FROM tasks')).toEqual(before)
      expect(await h.counts()).toEqual(counts)
    })
  })
