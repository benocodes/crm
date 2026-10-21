import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { backends, harness, fault, type Harness } from './test/backend.js'
for (const backend of backends)
  describe(backend, () => {
    let h: Harness
    beforeAll(async () => {
      h = await harness(backend)
    })
    afterAll(async () => {
      await h?.close()
    })
    for (const operation of ['task', 'resolve'])
      for (const stage of ['snapshot', 'first-mutation', 'first-event', 'result'])
        test(`${operation} rollback after ${stage}`, async () => {
          const row: any = await h.seed()
          await h.clearEvents()
          const before = await h.query('SELECT * FROM tasks')
          const counts = await h.counts()
          const p =
            operation === 'task'
              ? h.compileTask(row.id, { title: 'New' })
              : h.compileResolve([
                  { kind: 'email', value: `${stage}@example.com` },
                  { kind: 'email', value: `second-${stage}@example.com` },
                ])
          await expect(h.runtime.execute(fault<any>(p, stage))).rejects.toThrow()
          expect(await h.query('SELECT * FROM tasks')).toEqual(before)
          expect(await h.counts()).toEqual(counts)
        })
  })
