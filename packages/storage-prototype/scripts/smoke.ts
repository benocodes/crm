import '../src/test/setup.js'
import { strict as assert } from 'node:assert'
import { harness, backends, fault } from '../src/test/backend.js'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
for (const backend of backends) {
  const h = await harness(backend)
  try {
    const version =
      backend === 'postgres'
        ? (await h.query('SELECT current_database() AS name,version() AS version'))[0]
        : {
            version: 'local D1; SQLite version unavailable through binding',
            miniflare: '4.20260730.0',
            workerd: '1.20260730.1',
          }
    if (backend === 'postgres') assert.equal(version.name, 'vault_test_core33')
    console.log(JSON.stringify({ backend, ...version }))
    const task: any = await h.seed()
    await h.clearEvents()
    const cases = [
      ['task', () => h.task(task.id, { status: 'done' })],
      ['resolve-1', () => h.resolve([{ kind: 'email', value: 'smoke-one@example.com' }])],
      [
        'resolve-100',
        () =>
          h.resolve(
            Array.from({ length: 100 }, (_, i) => ({ kind: 'email', value: `smoke-${i}@example.com` })),
          ),
      ],
      ['resolve-known', () => h.resolve([{ kind: 'email', value: 'smoke-one@example.com' }])],
    ] as const
    for (const [name, run] of cases) {
      await h.clearEvents()
      const result = await run()
      const expected = name === 'task' ? 1 : name === 'resolve-1' ? 2 : name === 'resolve-100' ? 200 : 0
      const events = await h.events()
      assert.equal(events.length, expected)
      assert.equal(result.eventOrder.length, expected)
      for (const event of events) {
        assert.match(event.id, uuidPattern)
        assert.equal(event.actor_id, h.a.actor.id)
      }
      if (name === 'task') {
        assert.equal((result.value as any).status, 'done')
        assert.deepEqual(events[0].after, result.value)
      } else
        for (const item of result.value as any[]) {
          assert.match(item.identity.id, uuidPattern)
          if (item.created) {
            assert.deepEqual(events.find((e) => e.resource_id === item.identity.id)?.after, item.identity)
            assert.deepEqual(events.find((e) => e.resource_id === item.contact.id)?.after, item.contact)
          }
        }
      const counts = await h.counts()
      assert.equal(counts[backend === 'postgres' ? 'storage_prototype.rows' : 'prototype_rows'], 0)
      assert.equal(
        counts[backend === 'postgres' ? 'storage_prototype.operations' : 'prototype_operations'],
        0,
      )
      console.log(JSON.stringify({ backend, case: name, metrics: result.metrics }))
    }
    await h.clearEvents()
    const counts = await h.counts()
    await assert.rejects(h.runtime.execute(fault(h.compileTask(task.id, { title: 'rolled back' }), 'result')))
    assert.deepEqual(await h.counts(), counts)
    const program = h.compileTask(task.id, { title: 'representative' })
    console.log(
      JSON.stringify({
        backend,
        failedBatch: 'rolled back',
        sql: program.statements.map((s) => ({ stage: s.label, sql: s.sql, parameters: s.parameters.length })),
      }),
    )
  } finally {
    await h.close()
  }
}
