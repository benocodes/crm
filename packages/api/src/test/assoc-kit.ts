// Test-only ([[CORE62]]). Drives the association operations through the registry's own `prepare` (the same code path the REST
// adapter runs after its scope check) on a D1 engine, with a ticking injected clock, and creates the records edges join.
import { expect } from 'vitest'
import { ApiError, mapStorageError } from '../errors.js'
import { createVaultRegistry } from '../operations.js'
import type { TenantOperation } from '../registry.js'
import { tasks } from '../resources/tasks.js'
import { createOperation } from '../storage/crud.js'
import { ScopeSet } from '../scopes.js'
import { BASE, identityKit } from './identity-kit.js'
import type { Engine } from './engines.js'
import { seedConversation } from './messaging-kit.js'

export type Rec = Record<string, any>
export type Opts = { as?: 'agent'; scopes?: readonly string[]; organizationId?: string }
export const ALL_READ = ['contacts:read', 'companies:read', 'tasks:read', 'messages:read', 'interactions:read', 'associations:read', 'associations:write']
/** An agent that may link and read everything except message content (threads). */
export const NO_MESSAGES = ALL_READ.filter((s) => s !== 'messages:read')

export function assocKit(e: Engine) {
  const registry = createVaultRegistry()
  const k = identityKit(e)
  let tick = 0
  const op = (name: string): TenantOperation => {
    const found = registry.get(name)
    if (!found || found.kind !== 'tenant') throw new Error(`operation ${name} is not registered`)
    return found
  }
  const envFor = (opts: Opts = {}) =>
    e.env({
      now: new Date(BASE + 60_000 + ++tick * 1000),
      ...(opts.as ? { as: opts.as } : {}),
      ...(opts.scopes ? { scopes: ScopeSet.parse([...opts.scopes]) } : {}),
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    })
  const call = async (name: string, input: { params?: Rec; query?: Rec; body?: unknown }, opts: Opts = {}): Promise<any> => {
    const prepared = await op(name).prepare(envFor(opts), { params: {}, query: {}, body: undefined, ...input })
    return (await e.run(prepared, opts.as)).value
  }
  const fail = async (name: string, input: { params?: Rec; query?: Rec; body?: unknown }, opts: Opts = {}): Promise<ApiError> => {
    const err = await call(name, input, opts).then(() => undefined, (x: unknown) => x)
    expect(err, 'expected the call to fail').toBeDefined()
    const mapped = mapStorageError(err)
    expect(mapped).toBeInstanceOf(ApiError)
    return mapped as ApiError
  }
  const link = (a: [string, string], b: [string, string], opts?: Opts, relation?: string): Promise<Rec> =>
    call('associations.create', { body: { a_type: a[0], a_id: a[1], b_type: b[0], b_id: b[1], ...(relation ? { relation } : {}) } }, opts)
  const unlink = (id: string, opts?: Opts) => call('associations.delete', { params: { id } }, opts)
  const get = (id: string, opts?: Opts) => call('associations.get', { params: { id } }, opts)
  const list = (type: string, id: string, query: Rec = {}, opts?: Opts): Promise<{ data: Rec[]; next_cursor: string | null }> =>
    call('associations.list', { query: { type, id, ...query } }, opts)

  const ent = {
    contact: async (name = 'C'): Promise<[string, string]> => ['contacts', (await k.contact({ name })).id],
    company: async (name = 'Co'): Promise<[string, string]> => ['companies', (await k.company({ name })).id],
    task: async (title = 'T'): Promise<[string, string]> => ['tasks', (await k.run((env) => createOperation(tasks, env, { title }))).id as string],
    thread: async (): Promise<[string, string]> => ['threads', (await seedConversation((t, row) => e.insert(t, row))).threadId],
    interaction: async (): Promise<[string, string]> => ['interactions', (await seedConversation((t, row) => e.insert(t, row))).interactionId!],
  }
  const edges = async (live = true) => (await e.rows('associations')).filter((r) => !live || r.deleted_at === null)
  const events = async (prefix = 'association.') => (await e.rows('events')).filter((x) => String(x.type).startsWith(prefix))
  return { k, registry, call, fail, link, unlink, get, list, ent, edges, events, envFor }
}
export type AssocKit = ReturnType<typeof assocKit>
