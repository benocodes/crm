import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { backends, harness, type Harness } from './test/backend.js'
for (const backend of backends)
  describe(backend, () => {
    let h: Harness
    beforeAll(async () => {
      h = await harness(backend)
    })
    afterAll(async () => {
      await h?.close()
    })
    test('foreign task remains absent and other binding/org unchanged', async () => {
      const foreign: any = await h.seed(h.b)
      const before = await h.query('SELECT * FROM tasks', [], 'b')
      await expect(h.task(foreign.id, {})).rejects.toMatchObject({ status: 404 })
      expect(await h.query('SELECT * FROM tasks', [], 'b')).toEqual(before)
    })
    test('wrong binding context rejects before SQL, or PG segregates same address', async () => {
      if (backend === 'd1') {
        await expect(h.resolve([{ kind: 'email', value: 'wrong@example.com' }], h.b)).rejects.toMatchObject({
          status: 403,
        })
        return
      }
      const a = await h.resolve([{ kind: 'email', value: 'same@example.com' }])
      const b = await h.resolve([{ kind: 'email', value: 'same@example.com' }], h.b)
      expect(a.value[0].identity.id).not.toBe(b.value[0].identity.id)
      expect(b.value[0].identity.organization_id).toBe(h.b.organizationId)
    })
    test('both D1 bindings execute independently; PG raw access fails closed', async () => {
      if (backend === 'postgres') {
        const { CompiledQuery } = await import('kysely')
        await expect(
          (h as any).db.executeQuery(CompiledQuery.raw('SELECT * FROM tasks')),
        ).rejects.toMatchObject({ code: '42501' })
        return
      }
      const { d1Runtime } = await import('./runtime/d1.js')
      const { prepareResolveIdentities } = await import('./prepare.js')
      const { compileOperation } = await import('./compile.js')
      const { uuid7 } = await import('./uuid7.js')
      const runtime = d1Runtime((h as any).mf, h.b.organizationId, 'b')
      const input = [{ kind: 'email' as const, value: 'separate-bindings@example.com' }]
      const a = await h.resolve(input)
      const b = await runtime.execute(
        compileOperation(
          prepareResolveIdentities(h.b, input, {
            operationId: uuid7(),
            now: new Date().toISOString(),
            nextId: uuid7,
          }),
          'd1',
        ),
      )
      expect(a.value[0].identity.id).not.toBe(b.value[0].identity.id)
      expect(b.value[0].identity.organization_id).toBe(h.b.organizationId)
      expect(
        (await h.query('SELECT * FROM identities', [], 'b')).every(
          (r) => r.organization_id === h.b.organizationId,
        ),
      ).toBe(true)
    })
  })
