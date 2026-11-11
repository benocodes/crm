import { describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { parseListQuery } from '../resources/define.js'
import { describeColumnFilter } from './column-filters.js'

// [[CORE201]] D10, D12, D18: engine-neutral checks of the rollout's declarations.
const registry = createVaultRegistry()
const def = (name: string) => registry.resources().find((d) => d.name === name) as any

describe('every generic list is wrapped (D10)', () => {
  it('each resource that serves a list carries column filters, and the identities value reads its kind through the grammar', () => {
    for (const name of ['companies', 'contacts', 'tasks', 'tags', 'notes', 'identities', 'files', 'messages', 'interactions', 'threads', 'pipelines', 'pipeline_stages', 'connections', 'agents', 'api_keys', 'memberships', 'contact_files', 'company_files', 'action_requests', 'action_executions']) {
      expect(Object.keys(def(name).columnFilters ?? {}).length, name).toBeGreaterThan(0)
    }
  })
  it('identities: value needs kind as an equality; kind=in.(...) does not give it one', () => {
    const q = (filters: Record<string, string>) => parseListQuery(def('identities'), { filters })
    expect(q({ kind: 'email', value: 'ADA@Example.com' }).filters.value).toMatchObject({ op: 'eq', value: 'ada@example.com' })
    expect(q({ kind: 'eq.email', value: 'in.(A@b.co,C@d.co)' }).filters.value).toMatchObject({ op: 'in', value: ['a@b.co', 'c@d.co'] })
    expect(() => q({ value: 'a@b.co' })).toThrow(/filter value requires kind/)
    expect(() => q({ kind: 'in.(email)', value: 'a@b.co' })).toThrow(/filter value requires kind/)
  })
  it('an enum option rejects a value outside it; a UUID option rejects a non-UUID', () => {
    expect(() => parseListQuery(def('tasks'), { filters: { status: 'bogus' } })).toThrow(/filter status/)
    expect(() => parseListQuery(def('tasks'), { filters: { assignee_id: 'nope' } })).toThrow(/filter assignee_id/)
    expect(parseListQuery(def('tasks'), { filters: { status: 'in.(open,done)' } }).filters.status).toMatchObject({ op: 'in', value: ['open', 'done'] })
  })
})

describe('descriptions (D10, D12, D18)', () => {
  const text = (list: string, filter: string) => describeColumnFilter(filter, def(list).columnFilters[filter])
  it('a free-text filter states the eq. escape with its own name', () => {
    for (const [list, f] of [['companies', 'domain'], ['tags', 'name'], ['messages', 'external_id'], ['messages', 'in_reply_to'], ['action_requests', 'operation'], ['action_requests', 'dedup_key'], ['identities', 'value']] as const) {
      expect(text(list, f), `${list}.${f}`).toContain(`${f}=eq.`)
    }
  })
  it('every column filter says which comparisons read every live row', () => {
    for (const [list, f] of [['tasks', 'title'], ['tasks', 'due_at'], ['deals', 'amount_minor'], ['identities', 'own']] as const) {
      expect(text(list, f), `${list}.${f}`).toContain('neq, not., like and ilike read every live row')
    }
  })
  it('a text description names its collation: NOCASE names fold ASCII case, others use byte order', () => {
    expect(text('tags', 'name')).toContain('Comparison folds ASCII case')
    expect(text('tags', 'name')).not.toContain('Comparison is by byte order')
    expect(text('deals', 'name')).toContain('Comparison is by byte order')
    expect(text('deals', 'name')).not.toContain('Comparison folds ASCII case')
  })
  it('the tag filter says it is case-sensitive and differs from tags?name=', () => {
    const d = def('tasks').customFilters.tag.schema.description as string
    expect(d).toContain('case-sensitive')
    expect(d).toContain('tags?name=')
  })
})
