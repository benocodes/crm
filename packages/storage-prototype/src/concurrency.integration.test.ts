import { isDeepStrictEqual } from 'node:util'
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
    for (const scenario of [
      'same address',
      'overlapping reverse batches',
      'preexisting overlap',
      'disjoint task fields',
      'competing status',
    ])
      test(`${scenario}: 20 coordinated trials`, async () => {
        for (let n = 0; n < 20; n++) {
          await h.clearEvents()
          // Both promises wait at one barrier; PG max=4 supplies independent connections.
          let go!: () => void
          const gate = new Promise<void>((r) => {
            go = r
          })
          const launch = (fn: () => Promise<any>) => gate.then(fn)
          if (['same address', 'overlapping reverse batches', 'preexisting overlap'].includes(scenario)) {
            const entries = [
              { kind: 'email', value: `${scenario.replaceAll(' ', '')}-${n}@example.com` },
              { kind: 'email', value: `other-${scenario.replaceAll(' ', '')}-${n}@example.com` },
            ]
            const single = scenario === 'same address'
            const inputs = single ? [entries[0]] : entries
            const preexisting = scenario === 'preexisting overlap'
            if (preexisting) {
              await h.resolve([entries[0]])
              await h.clearEvents()
            }
            const other =
              scenario === 'overlapping reverse batches'
                ? [entries[1], entries[0], { kind: 'email', value: `third-${n}@example.com` }]
                : [...inputs].reverse()
            const missing = scenario === 'overlapping reverse batches' ? 3 : preexisting ? 1 : inputs.length
            const before = await h.counts()
            const a = launch(() => h.resolve(inputs)),
              b = launch(() => h.resolve(other))
            go()
            const results = await Promise.all([a, b])
            expect(results.flatMap((x) => x.value).filter((x) => x.created)).toHaveLength(missing)
            const after = await h.counts()
            expect(after.contacts - before.contacts).toBe(missing)
            expect(after.identities - before.identities).toBe(missing)
            expect(after.events).toBe(missing * 2)
            expect(after.principals).toBe(before.principals)
            expect(after[backend === 'postgres' ? 'storage_prototype.rows' : 'prototype_rows']).toBe(0)
            expect(
              after[backend === 'postgres' ? 'storage_prototype.operations' : 'prototype_operations'],
            ).toBe(0)
            for (const x of results[0].value) {
              expect(
                results[1].value.find((y: any) => y.identity.value === x.identity.value).identity.id,
              ).toBe(x.identity.id)
            }
            for (const r of results)
              for (const x of r.value)
                if (x.created) {
                  expect((await h.events()).filter((e) => e.resource_id === x.identity.id)).toHaveLength(1)
                }
          } else {
            const row: any = await h.seed()
            await h.clearEvents()
            const disjoint = scenario === 'disjoint task fields'
            const a = launch(() =>
                h.runtime.execute(
                  h.compileTask(
                    row.id,
                    disjoint ? { title: 'Race' } : { status: 'done' },
                    h.a,
                    '2026-10-21T12:00:00.001Z',
                  ),
                ),
              ),
              b = launch(() =>
                h.runtime.execute(
                  h.compileTask(
                    row.id,
                    disjoint ? { notes: 'Both' } : { status: 'open' },
                    h.a,
                    '2026-10-21T12:00:00.002Z',
                  ),
                ),
              )
            go()
            await Promise.all([a, b])
            const final = (await h.task(row.id, {})).value
            const events = await h.events()
            expect(events).toHaveLength(2)
            const chain = (a: any, b: any) =>
              isDeepStrictEqual(a.before, row) &&
              isDeepStrictEqual(a.after, b.before) &&
              isDeepStrictEqual(b.after, final)
            expect(chain(events[0], events[1]) || chain(events[1], events[0])).toBe(true)
            if (disjoint) expect(final).toMatchObject({ title: 'Race', notes: 'Both' })
            else {
              expect(final.completed_at === null).toBe(final.status === 'open')
              if (final.status === 'done') expect(final.completed_at).toBe('2026-10-21T12:00:00.001Z')
            }
          }
        }
      })
  })
