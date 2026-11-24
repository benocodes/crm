// Test-only. [[CORE559]]: the extension fields of the four built-ins served through the `extend` seam. A local D1 with the extension columns applied by [[CORE555]]'s apply, the production registry built with the
// same `extend`, and the prerequisites a record of each resource needs.
import type { D1Like } from '@vibase/storage-d1'
import { applyExtensions } from '../custom/apply.js'
import type { ExtendDeclarations } from '../custom/extend.js'
import type { FieldDeclaration } from '../custom/declaration.js'
import { createVibaseRegistry } from '../operations.js'
import { openActionKit, type ActionKit, type Actor } from './action-kit.js'

export const RESOURCES = ['contacts', 'companies', 'deals', 'tasks'] as const
export type Resource = (typeof RESOURCES)[number]
/** The event type's resource name of each table. */
export const EVENT_OF: Record<Resource, string> = { contacts: 'contact', companies: 'company', deals: 'deal', tasks: 'task' }

/** One field of each kind. */
export const ONE_OF_EACH: Record<string, FieldDeclaration> = {
  note__c: { kind: 'text' },
  seats__c: { kind: 'integer' },
  vip__c: { kind: 'boolean' },
  renew__c: { kind: 'timestamp' },
  tier__c: { kind: 'enum', values: ['gold', 'silver'] },
  parent__c: { kind: 'reference', target: 'companies' },
}
/** The rules of D8, D20, D22: required with no default, required with a default, unique. */
export const RULES: Record<string, FieldDeclaration> = {
  req__c: { kind: 'text', required: true },
  lvl__c: { kind: 'enum', values: ['a', 'b'], required: true, default: 'a' },
  code__c: { kind: 'text', unique: true },
  seq__c: { kind: 'integer', unique: true },
  co__c: { kind: 'reference', target: 'companies' },
}
export const every = (fields: Record<string, FieldDeclaration>): ExtendDeclarations => ({
  contacts: fields,
  companies: fields,
  deals: fields,
  tasks: fields,
})

export async function applyExtend(d1: D1Like, extend: ExtendDeclarations): Promise<void> {
  const r = await applyExtensions(d1, {}, extend)
  if (r.refused.length > 0) throw new Error(JSON.stringify(r.refused))
}

/** A kit whose registry and database both carry `extend` (the registry is the production one, [[CORE559]] P1). */
export async function openExtendedKit(extend: ExtendDeclarations, now?: Date): Promise<ActionKit> {
  const k = await openActionKit({ registry: createVibaseRegistry({ extend }), ...(now ? { now } : {}) })
  await applyExtend(k.d1, extend)
  return k
}

export const pathOf = (r: Resource) => `/api/v1/${r}`

/** The body that creates one record of `r` (a deal needs a stage, made through the public API). */
export async function baseBody(k: ActionKit, owner: Actor, r: Resource, n = 1): Promise<Record<string, unknown>> {
  switch (r) {
    case 'contacts':
      return { name: `Contact ${n}` }
    case 'companies':
      return { name: `Company ${n}` }
    case 'tasks':
      return { title: `Task ${n}` }
    case 'deals': {
      const p = await k.call(owner, 'POST', '/meta/v1/pipelines', { name: `P ${n}` })
      const s = await k.call(owner, 'POST', '/meta/v1/pipeline-stages', {
        pipeline_id: p.body.id,
        name: 'Open',
        kind: 'open',
        position: 10,
      })
      return { name: `Deal ${n}`, stage_id: s.body.id }
    }
  }
}

export async function company(k: ActionKit, owner: Actor, name = 'Parent Co'): Promise<string> {
  const r = await k.call(owner, 'POST', '/api/v1/companies', { name })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.id as string
}
