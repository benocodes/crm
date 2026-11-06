// Test-only. One valid call per proposal-eligible operation ([[AGT8]] D32), so the permission matrix is generated from the manifest and a
// newly eligible operation fails the suite until it has a fixture here. A fixture makes its prerequisites as the owner, through the public API.
import type { Operation, Registry, TenantOperation } from '../registry.js'
import { proposableOperations } from '../proposal.js'
import type { ActionKit, Actor } from './action-kit.js'

export interface Prereq {
  post(path: string, body: unknown): Promise<{ id: string; [k: string]: any }>
}
export interface CallFixture {
  /** The call's flat arguments (what `action_requests.create` takes as `arguments`), with prerequisites made fresh. */
  args: (o: Prereq, n: number) => Promise<Record<string, unknown>>
  /** Read scopes the call needs beyond its write scope (the operation's own checks, for example both ends of an association). */
  reads?: string[]
}

const stage = async (o: Prereq, n: number) => {
  const pipeline = await o.post('/meta/v1/pipelines', { name: `P${n}-${Math.random()}` })
  const s = await o.post('/meta/v1/pipeline-stages', { pipeline_id: pipeline.id, name: 'Open', kind: 'open', position: 10 })
  return { pipeline, stage: s }
}

export const FIXTURES: Record<string, CallFixture> = {
  'tasks.create': { args: async (_o, n) => ({ title: `task ${n}` }) },
  'tasks.update': { args: async (o, n) => ({ id: (await o.post('/api/v1/tasks', { title: 'a' })).id, title: `renamed ${n}` }) },
  'tasks.delete': { args: async (o) => ({ id: (await o.post('/api/v1/tasks', { title: 'a' })).id }) },
  'companies.create': { args: async (_o, n) => ({ name: `Co ${n}` }) },
  'companies.update': { args: async (o, n) => ({ id: (await o.post('/api/v1/companies', { name: `C${n}` })).id, name: `Renamed ${n}` }) },
  'companies.delete': { args: async (o, n) => ({ id: (await o.post('/api/v1/companies', { name: `C${n}` })).id }) },
  'contacts.create': { args: async (_o, n) => ({ name: `Ann ${n}` }) },
  'contacts.update': { args: async (o, n) => ({ id: (await o.post('/api/v1/contacts', { name: 'A' })).id, name: `Bea ${n}` }) },
  'contacts.delete': { args: async (o) => ({ id: (await o.post('/api/v1/contacts', { name: 'A' })).id }) },
  'contacts.merge': {
    args: async (o) => ({ id: (await o.post('/api/v1/contacts', { name: 'Keep' })).id, source_id: (await o.post('/api/v1/contacts', { name: 'Fold' })).id }),
  },
  'identities.create': { args: async (o, n) => ({ kind: 'email', value: `x${n}-${Math.random().toString(36).slice(2)}@example.test`, contact_id: (await o.post('/api/v1/contacts', { name: 'A' })).id }) },
  'identities.update': {
    args: async (o, n) => {
      const c = await o.post('/api/v1/contacts', { name: 'A' })
      const i = await o.post('/api/v1/identities', { kind: 'email', value: `u${n}-${Math.random().toString(36).slice(2)}@example.test` , contact_id: c.id })
      return { id: i.id, contact_id: (await o.post('/api/v1/contacts', { name: 'B' })).id }
    },
  },
  'identities.delete': { args: async (o, n) => ({ id: (await o.post('/api/v1/identities', { kind: 'email', value: `d${n}-${Math.random().toString(36).slice(2)}@example.test`, contact_id: (await o.post('/api/v1/contacts', { name: 'A' })).id })).id }) },
  'identities.resolve': { args: async (_o, n) => ({ identities: [{ kind: 'email', value: `r${n}-${Math.random().toString(36).slice(2)}@example.test` }] }) },
  'notes.create': { args: async (_o, n) => ({ content: `note ${n}` }) },
  'notes.update': { args: async (o, n) => ({ id: (await o.post('/api/v1/notes', { content: 'a' })).id, content: `b ${n}` }) },
  'notes.delete': { args: async (o) => ({ id: (await o.post('/api/v1/notes', { content: 'a' })).id }) },
  'tags.create': { args: async (_o, n) => ({ name: `tag ${n} ${Math.random()}` }) },
  'tags.update': { args: async (o, n) => ({ id: (await o.post('/api/v1/tags', { name: `t${n} ${Math.random()}` })).id, description: 'd' }) },
  'tags.delete': { args: async (o, n) => ({ id: (await o.post('/api/v1/tags', { name: `t${n} ${Math.random()}` })).id }) },
  'pipelines.create': { args: async (_o, n) => ({ name: `Pipe ${n} ${Math.random()}` }) },
  'pipelines.update': { args: async (o, n) => ({ id: (await o.post('/meta/v1/pipelines', { name: `Pp${n} ${Math.random()}` })).id, name: `Renamed ${n} ${Math.random()}` }) },
  'pipelines.delete': { args: async (o, n) => ({ id: (await o.post('/meta/v1/pipelines', { name: `Pd${n} ${Math.random()}` })).id }) },
  'pipeline_stages.create': { args: async (o, n) => ({ pipeline_id: (await o.post('/meta/v1/pipelines', { name: `Ps${n} ${Math.random()}` })).id, name: 'Won', kind: 'won', position: 20 }) },
  'pipeline_stages.update': { args: async (o, n) => ({ id: (await stage(o, n)).stage.id, name: `Renamed ${n}` }) },
  'pipeline_stages.delete': { args: async (o, n) => ({ id: (await stage(o, n)).stage.id }) },
  'deals.create': { args: async (o, n) => ({ name: `Deal ${n}`, stage_id: (await stage(o, n)).stage.id }) },
  'deals.update': { args: async (o, n) => ({ id: (await o.post('/api/v1/deals', { name: 'D', stage_id: (await stage(o, n)).stage.id })).id, name: `Deal ${n} v2` }) },
  'deals.delete': { args: async (o, n) => ({ id: (await o.post('/api/v1/deals', { name: 'D', stage_id: (await stage(o, n)).stage.id })).id }) },
  'deals.move_stage': {
    args: async (o, n) => {
      const { pipeline, stage: open } = await stage(o, n)
      const won = await o.post('/meta/v1/pipeline-stages', { pipeline_id: pipeline.id, name: 'Won', kind: 'won', position: 20 })
      return { id: (await o.post('/api/v1/deals', { name: 'D', stage_id: open.id })).id, stage_id: won.id }
    },
  },
  'associations.create': {
    reads: ['tasks:read', 'contacts:read'],
    args: async (o) => ({ a_type: 'tasks', a_id: (await o.post('/api/v1/tasks', { title: 'a' })).id, b_type: 'contacts', b_id: (await o.post('/api/v1/contacts', { name: 'A' })).id }),
  },
  'associations.delete': {
    reads: ['tasks:read', 'contacts:read'],
    args: async (o) => {
      const t = await o.post('/api/v1/tasks', { title: 'a' })
      const c = await o.post('/api/v1/contacts', { name: 'A' })
      return { id: (await o.post('/api/v1/associations', { a_type: 'tasks', a_id: t.id, b_type: 'contacts', b_id: c.id })).id }
    },
  },
}

export const prereq = (k: ActionKit): Prereq => ({
  async post(path, body) {
    const r = await k.call(k.owner, 'POST', path, body)
    if (r.status >= 300) throw new Error(`prerequisite ${path} failed: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  },
})

/** The direct REST call of an operation with flat arguments: path parameters into the path, the rest in the body (or the query for a get). */
export function directCall(op: Operation, args: Record<string, unknown>): { method: string; path: string; body?: unknown } {
  const params = Object.keys(op.request?.params?.shape ?? {})
  let path = (op.surface === 'api' ? '/api/v1' : '/meta/v1') + op.path
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (params.includes(key)) path = path.replace(`{${key}}`, String(value))
    else body[key] = value
  }
  return { method: op.method.toUpperCase(), path, ...(op.method === 'delete' || Object.keys(body).length === 0 ? {} : { body }) }
}

export const ownerOf = (k: ActionKit): Actor => k.owner
export const eligible = (registry: Registry): TenantOperation[] => proposableOperations(registry)
