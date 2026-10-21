import { expect, test } from 'vitest'
import { ScopeSet } from '@vault/api'
import { prepareTaskUpdate, prepareResolveIdentities } from './prepare.js'
import { ctx, task, prep } from './test/data.js'
test('scope fails before id allocation', () => {
  const p = {
    ...prep(),
    nextId: () => {
      throw new Error('allocated')
    },
  }
  expect(() => prepareTaskUpdate({ ...ctx, scopes: ScopeSet.parse([]) }, { id: task, patch: {} }, p)).toThrow(
    'requires tasks:write',
  )
  expect(() =>
    prepareResolveIdentities({ ...ctx, scopes: ScopeSet.parse(['contacts:read']) }, [], p),
  ).toThrow('requires contacts:write')
})
test('strict task normalization', () =>
  expect(
    prepareTaskUpdate(ctx, { id: task, patch: { title: ' New ', notes: null, status: 'done' } }, prep()).input
      .patch,
  ).toEqual({ title: 'New', notes: null, status: 'done' }))
test.each([
  { title: '' },
  { title: 'a'.repeat(501) },
  { notes: 'a'.repeat(10001) },
  { status: 'bad' },
  { organization_id: ctx.organizationId },
  { actor_id: ctx.actor.id },
  { due_at: null },
  { assignee_id: null },
])('rejects patch %j', (patch) => expect(() => prepareTaskUpdate(ctx, { id: task, patch }, prep())).toThrow())
test('invalid target is not found', () =>
  expect(() => prepareTaskUpdate(ctx, { id: 'bad', patch: {} }, prep())).toThrow('task not found'))
test('normalizes all entries and cleans first blank name', () => {
  const input = [
    { kind: 'email' as const, value: ' A@EXAMPLE.COM ', name: ' ' },
    { kind: 'email' as const, value: 'a@example.com', name: 'x'.repeat(501) },
  ]
  const op = prepareResolveIdentities(ctx, input, prep())
  expect(op.input.entries.map((e: any) => [e.value, e.name])).toEqual([
    ['a@example.com', null],
    ['a@example.com', 'x'.repeat(500)],
  ])
  expect(input[0].value).toBe(' A@EXAMPLE.COM ')
  expect(Object.isFrozen(op)).toBe(true)
})
test('resolve limits and indexed invalid address', () => {
  expect(prepareResolveIdentities(ctx, [], prep()).input.entries).toEqual([])
  expect(
    prepareResolveIdentities(
      ctx,
      Array.from({ length: 100 }, (_, i) => ({ kind: 'email', value: `a${i}@example.com` })),
      prep(),
    ).input.entries,
  ).toHaveLength(100)
  expect(() =>
    prepareResolveIdentities(ctx, Array(101).fill({ kind: 'email', value: 'a@b.com' }), prep()),
  ).toThrow()
  expect(() =>
    prepareResolveIdentities(
      ctx,
      [
        { kind: 'email', value: 'a@b.com' },
        { kind: 'phone', value: 'bad' },
      ],
      prep(),
    ),
  ).toThrow('identities[1]:')
})
