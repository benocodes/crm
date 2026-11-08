import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Registry, type TenantOperation } from '../registry.js'
import { createVaultRegistry } from '../operations.js'
import { enqueuedOperation } from './enqueue.js'
import { registerTestOperations, TEST_OPS } from '../test/rail-kit.js'

// [[AGT8]] D2, D51, D52, D57: what the registry accepts as an enqueued operation, and what a production registry holds.
const spec = {
  name: 'things.send',
  summary: 'Send a thing',
  path: '/things-send',
  scope: { resource: 'tasks', action: 'write' } as const,
  transport: 'test',
  readScope: { resource: 'tasks', action: 'read' } as const,
  input: z.strictObject({ text: z.string() }),
}

describe('enqueuedOperation', () => {
  it('declares a direct call that needs an idempotency_key and answers 202 with the execution', () => {
    const op = enqueuedOperation(spec)
    expect(op).toMatchObject({ kind: 'tenant', method: 'post', surface: 'api', d1Only: true, replanOnDrift: true, response: { status: 202 }, scope: { resource: 'tasks', action: 'write' } })
    expect(op.proposal).toMatchObject({ eligible: true })
    expect(op.execution).toMatchObject({ transport: 'test', readScope: { resource: 'tasks', action: 'read' } })
    const body = op.request!.body as z.ZodObject
    expect(Object.keys(body.shape).sort()).toEqual(['idempotency_key', 'text'])
    expect(body.safeParse({ text: 'x' }).success).toBe(false)
    expect(body.safeParse({ text: 'x', idempotency_key: '' }).success).toBe(false)
    expect(body.safeParse({ text: 'x', idempotency_key: 'k'.repeat(201) }).success).toBe(false)
    expect(body.safeParse({ text: 'x', idempotency_key: 'k' }).success).toBe(true)
    expect(op.execution!.input.safeParse({ text: 'x' }).success).toBe(true)
  })

  it('defaults the retry policy to reconcile when none is declared', () => {
    expect(enqueuedOperation(spec).execution!.retry ?? 'reconcile').toBe('reconcile')
    expect(enqueuedOperation({ ...spec, retry: 'never' }).execution!.retry).toBe('never')
  })

  it('refuses an own input that already has an idempotency_key field', () => {
    expect(() => enqueuedOperation({ ...spec, input: z.strictObject({ text: z.string(), idempotency_key: z.string() }) })).toThrow(/idempotency_key/)
  })
})

describe('Registry.register of an enqueued operation', () => {
  const ok = () => enqueuedOperation(spec)
  const registerWith = (change: (op: TenantOperation) => TenantOperation) => new Registry().register(change(ok()))

  it('accepts the builder\'s operation, which may be d1Only and carry an after stage', () => {
    expect(() => new Registry().register(ok())).not.toThrow()
  })
  it('refuses a method other than post', () => {
    expect(() => registerWith((op) => ({ ...op, method: 'patch' }))).toThrow(/post/)
  })
  it('refuses a status other than 202', () => {
    expect(() => registerWith((op) => ({ ...op, response: { status: 200, schema: z.object({}) } }))).toThrow(/202/)
  })
  it('refuses a scope that is not a write scope', () => {
    expect(() => registerWith((op) => ({ ...op, scope: { resource: 'tasks', action: 'read' } }))).toThrow(/write/)
  })
  it('refuses path or query parameters (the arguments are one flat object)', () => {
    expect(() => registerWith((op) => ({ ...op, request: { ...op.request, params: z.object({ id: z.string() }) } }))).toThrow(/param/)
  })
  it('refuses a body that does not require idempotency_key', () => {
    expect(() => registerWith((op) => ({ ...op, request: { body: z.object({ text: z.string() }) } }))).toThrow(/idempotency_key/)
  })
  it('refuses a read scope that is not a read scope', () => {
    expect(() => registerWith((op) => ({ ...op, execution: { ...op.execution!, readScope: { resource: 'tasks', action: 'write' } } }))).toThrow(/read/)
  })
  it('an operation without `execution` stays inline: a proposable one still may not be d1Only or have an after stage', () => {
    const inline = (extra: Partial<TenantOperation>) => () =>
      new Registry().register({ ...ok(), execution: undefined, ...extra } as TenantOperation)
    expect(inline({ d1Only: true })).toThrow(/runs inline/)
    expect(inline({ after: async (v) => v })).toThrow(/runs inline/)
  })
  it('is declared by its write scope and its proposal scope, and no scope of its own for reads', () => {
    expect(new Registry().register(ok()).declaredScopes()).toEqual(['tasks:request_approval', 'tasks:write'])
  })
})

describe('the production registry', () => {
  it('registers Gmail send as the sole production enqueued operation', () => {
    expect(createVaultRegistry().operations().filter((o) => o.kind === 'tenant' && o.execution).map(o => o.name)).toEqual(['messages.send'])
    expect(createVaultRegistry().get('messages.send')).toMatchObject({execution:{transport:'gmail'},response:{status:202}})
  })
  it('has the two execution reads, which declare no scope of their own and add none to the catalog', () => {
    const r = createVaultRegistry()
    for (const name of ['action_executions.list', 'action_executions.get']) {
      const op = r.get(name)
      expect(op).toMatchObject({ kind: 'tenant', scope: null, authority: 'read', d1Only: true, surface: 'api' })
    }
    expect(r.declaredScopes().filter((s) => s.startsWith('action_executions'))).toEqual([])
  })
  it('the test operations only exist where a test registers them', () => {
    const names = (r: Registry) => r.operations().map((o) => o.name)
    expect(names(createVaultRegistry())).not.toContain(TEST_OPS.reconcile)
    expect(names(createVaultRegistry({ operations: registerTestOperations }))).toEqual(expect.arrayContaining(Object.values(TEST_OPS)))
  })
  it('an enqueued operation is listed by action_requests.create like any proposable one, ahead of the queue itself', () => {
    const r = createVaultRegistry({ operations: registerTestOperations })
    const create = r.get('action_requests.create') as TenantOperation
    const op = (create.request!.body as z.ZodObject).shape.operation as z.ZodEnum
    expect(op.options).toEqual(expect.arrayContaining(Object.values(TEST_OPS)))
  })
})
