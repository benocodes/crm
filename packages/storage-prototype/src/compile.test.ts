import { expect, test } from 'vitest'
import { compileOperation } from './compile.js'
import { ctx, task, prep } from './test/data.js'
// Valid immutable descriptions keep compiler reds independent from preparation stubs.
const op: any = {
  context: ctx,
  operationId: prep().operationId,
  now: prep().now,
  input: { id: task, patch: { title: "'; DROP TABLE tasks; --" } },
  kind: 'task',
  eventId: prep().nextId(),
  rowId: prep().nextId(),
  locks: [],
}
test.each(['postgres', 'd1'] as const)(
  'compiles parameterized fixed stages without a connection: %s',
  (dialect) => {
    const p = compileOperation(op, dialect)
    expect(p.statements.length).toBeGreaterThan(4)
    expect(p.statements.map((s: any) => s.sql).join('\n')).not.toContain('DROP TABLE tasks')
    const labels = p.statements.map((s: any) => s.label)
    expect(labels.indexOf('snapshot')).toBeLessThan(labels.indexOf('first-mutation'))
    expect(labels.indexOf('first-event')).toBeLessThan(labels.indexOf('result'))
    expect(labels.indexOf('result')).toBeLessThan(labels.lastIndexOf('cleanup'))
  },
)

test('100-entry JSON relation stays below D1 parameter ceiling and binds injection text', async () => {
  const { prepareResolveIdentities } = await import('./prepare.js')
  const operation = prepareResolveIdentities(
    ctx,
    Array.from({ length: 100 }, (_, i) => ({
      kind: 'email',
      value: `a${i}@example.com`,
      name: "'; DROP TABLE contacts; --",
    })),
    prep(),
  )
  const p = compileOperation(operation, 'd1')
  for (const statement of p.statements) {
    expect(statement.parameters.length).toBeLessThanOrEqual(100)
    expect(statement.sql).not.toContain('DROP TABLE contacts')
  }
  expect(
    p.statements.some((s) =>
      s.parameters.some((v) => typeof v === 'string' && v.includes('DROP TABLE contacts')),
    ),
  ).toBe(true)
})
