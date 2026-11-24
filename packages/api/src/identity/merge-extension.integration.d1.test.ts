import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ExtendDeclarations } from '../custom/extend.js'
import type { ObjectDeclaration } from '../custom/declaration.js'
import { applyExtensions } from '../custom/apply.js'
import { defineCustomObject } from '../custom/resource.js'
import { createVibaseRegistry } from '../operations.js'
import { CONTACT_REFERENCES, CONTACT_REFERENCE_EXEMPTIONS, contactReferencesOf } from './merge.js'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { baseBody, type Resource } from '../test/extension-kit.js'

// [[CORE556]] D13, D21 (U3): `contacts.merge` over extension fields (the order of the unit, the fill, the conflicts it reports) and over references to contacts (a custom object and an `extend` field on companies, deals and
// tasks), on D1 through the production registry built with the same `extend` and `objects` as the database.
const PROJECTS = 'projects__c'
const OBJECTS: Record<string, ObjectDeclaration> = {
  [PROJECTS]: {
    fields: {
      name: { kind: 'text', required: true },
      note: { kind: 'text' },
      contact: { kind: 'reference', target: 'contacts' },
    },
  },
}
const EXTEND: ExtendDeclarations = {
  contacts: {
    code__c: { kind: 'text', unique: true },
    note__c: { kind: 'text' },
    seats__c: { kind: 'integer' },
    vip__c: { kind: 'boolean' },
    renew__c: { kind: 'timestamp' },
    tier__c: { kind: 'enum', values: ['gold', 'silver'] },
    co__c: { kind: 'reference', target: 'companies' },
  },
  companies: { contact__c: { kind: 'reference', target: 'contacts' }, note__c: { kind: 'text' } },
  deals: { contact__c: { kind: 'reference', target: 'contacts' }, note__c: { kind: 'text' } },
  tasks: { contact__c: { kind: 'reference', target: 'contacts' }, note__c: { kind: 'text' } },
}
const registry = () =>
  createVibaseRegistry({ extend: EXTEND, definitions: [defineCustomObject(PROJECTS, OBJECTS[PROJECTS]!)] })
const CONTACTS = '/api/v1/contacts'
let k: ActionKit
let owner: Actor
beforeAll(async () => {
  k = await openActionKit({ registry: registry() })
  const r = await applyExtensions(k.d1, OBJECTS, EXTEND)
  if (r.refused.length > 0) throw new Error(JSON.stringify(r.refused))
})
afterAll(() => k.close())
beforeEach(async () => {
  // Rows that reference contacts or companies go before the harness empties the core tables (`clearD1` cannot order a `__c` column it does not know).
  await k.d1.prepare(`delete from "${PROJECTS}"`).run()
  for (const t of ['companies', 'deals', 'tasks']) await k.d1.prepare(`update "${t}" set "contact__c" = null`).run()
  await k.d1.prepare(`update "contacts" set "co__c" = null`).run()
  await k.reset()
  owner = k.as(k.owner, k.registry.declaredScopes())
})

const contact = async (body: Record<string, unknown>) => {
  const r = await k.call(owner, 'POST', CONTACTS, body)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body as Record<string, any>
}
const merge = (survivor: string, source: string) =>
  k.call(owner, 'POST', `${CONTACTS}/${survivor}/merge`, { source_id: source })
const rowOf = async (table: string, id: string) =>
  (await k.d1.prepare(`select * from "${table}" where id = ?`).bind(id).first()) as Record<string, any>

describe('D13: the source is tombstoned before the survivor is filled', () => {
  it('a unique value the source holds moves to the survivor, and stays on the tombstone and in the merged event', async () => {
    const survivor = await contact({ name: 'S', code__c: null })
    const source = await contact({ name: 'R', code__c: 'ACME-1' })
    const res = await merge(survivor.id, source.id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ id: survivor.id, code__c: 'ACME-1' })
    expect((await rowOf('contacts', survivor.id)).code__c).toBe('ACME-1')
    const tomb = await rowOf('contacts', source.id)
    expect(tomb.deleted_at).not.toBeNull()
    expect(tomb.code__c).toBe('ACME-1')
    const [merged] = await k.events('contact.merged')
    expect(merged!.before).toMatchObject({ code__c: 'ACME-1' })
    const fill = (await k.events('contact.updated')).find((e) => e.resource_id === survivor.id)!
    expect(fill.after).toMatchObject({ code__c: 'ACME-1' })
  })
})

describe('D13: the fill and the conflicts, one case per field kind', () => {
  const company = async (name: string) =>
    ((await k.call(owner, 'POST', '/api/v1/companies', { name })).body as { id: string }).id
  // field, the survivor's value, the source's value (different), and a third form the source may hold equal to the survivor's.
  const KINDS: Array<[string, () => Promise<[unknown, unknown]>]> = [
    ['note__c', async () => ['keep', 'other']],
    ['seats__c', async () => [5, 0]],
    ['vip__c', async () => [true, false]],
    ['renew__c', async () => ['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z']],
    ['tier__c', async () => ['gold', 'silver']],
    ['co__c', async () => [await company('A'), await company('B')]],
  ]
  describe.each(KINDS)('%s', (field, values) => {
    it('survivor null and source set: the survivor takes the value, the event shows it, nothing is listed', async () => {
      const [, theirs] = await values()
      const survivor = await contact({ name: 'Same' })
      const source = await contact({ name: 'Same', [field]: theirs })
      const res = await merge(survivor.id, source.id)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body[field]).toEqual(theirs)
      expect(res.body.merge_conflicts).toEqual([])
      const fill = (await k.events('contact.updated')).find((e) => e.resource_id === survivor.id)!
      expect((fill.before as any)[field]).toBeNull()
      expect((fill.after as any)[field]).toEqual(theirs)
    })
    it('both set and different: the survivor keeps its value and the conflict names the source value', async () => {
      const [mine, theirs] = await values()
      const survivor = await contact({ name: 'Same', [field]: mine })
      const source = await contact({ name: 'Same', [field]: theirs })
      const res = await merge(survivor.id, source.id)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body[field]).toEqual(mine)
      expect(res.body.merge_conflicts).toEqual([{ field, source_value: theirs }])
      // The source's value stays on the tombstone.
      expect(((await k.events('contact.merged'))[0]!.before as any)[field]).toEqual(theirs)
    })
    it('both set and equal: not a conflict', async () => {
      const [mine] = await values()
      const survivor = await contact({ name: 'Same', [field]: mine })
      const source = await contact({ name: 'Same', [field]: mine })
      const res = await merge(survivor.id, source.id)
      expect(res.body[field]).toEqual(mine)
      expect(res.body.merge_conflicts).toEqual([])
    })
  })

  it('a core field conflicts too, and the list follows the definition field order', async () => {
    const survivor = await contact({ name: 'Mine', tier__c: 'gold', note__c: 'a' })
    const source = await contact({ name: 'Theirs', tier__c: 'silver', note__c: 'b' })
    const res = await merge(survivor.id, source.id)
    expect(res.body.merge_conflicts).toEqual([
      { field: 'name', source_value: 'Theirs' },
      { field: 'note__c', source_value: 'b' },
      { field: 'tier__c', source_value: 'silver' },
    ])
  })

  it('with nothing to report the result carries merge_conflicts: []', async () => {
    const survivor = await contact({ name: 'S' })
    const source = await contact({ name: null })
    const res = await merge(survivor.id, source.id)
    expect(res.body.merge_conflicts).toEqual([])
  })

  it('the property bag keeps its per-key fill and is not listed', async () => {
    const survivor = await contact({ name: 'S', additional_props: { a: 1 } })
    const source = await contact({ name: 'R', additional_props: { a: 2, b: 3 } })
    const res = await merge(survivor.id, source.id)
    expect(res.body.additional_props).toEqual({ a: 1, b: 3 })
    expect(res.body.merge_conflicts.map((c: { field: string }) => c.field)).toEqual(['name'])
  })
})

describe('D13, response contract', () => {
  it('the response validates against the declared schema, which REST and MCP both state', async () => {
    const survivor = await contact({ name: 'S', note__c: 'a' })
    const source = await contact({ name: 'R', note__c: 'b' })
    const res = await merge(survivor.id, source.id)
    const op = k.registry.get('contacts.merge') as unknown as { response: { schema: { parse(v: unknown): any } } }
    expect(op.response.schema.parse(res.body).merge_conflicts).toHaveLength(2)
    const doc = (await (await k.app.request('/api/v1/openapi.json')).json()) as any
    expect(JSON.stringify(doc.paths['/contacts/{id}/merge'] ?? doc.paths['/api/v1/contacts/{id}/merge'])).toContain(
      'merge_conflicts',
    )
  })
})

describe('D21: references to contacts, merge re-points them', () => {
  type Kind = Exclude<Resource, 'contacts'> | 'custom'
  const KINDS: Kind[] = ['companies', 'deals', 'tasks', 'custom']
  const make = async (kind: Kind, holder: string | null, note: string): Promise<string> => {
    if (kind === 'custom') {
      const r = await k.call(owner, 'POST', `/api/v1/${PROJECTS}`, { name: 'P', note, contact: holder })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      return r.body.id
    }
    const r = await k.call(owner, 'POST', `/api/v1/${kind}`, {
      ...(await baseBody(k, owner, kind)),
      note__c: note,
      contact__c: holder,
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return r.body.id
  }
  const table = (kind: Kind) => (kind === 'custom' ? PROJECTS : kind)
  const column = (kind: Kind) => (kind === 'custom' ? 'contact' : 'contact__c')
  const eventType = (kind: Kind) =>
    `${{ custom: PROJECTS, companies: 'company', deals: 'deal', tasks: 'task' }[kind]}.updated`

  describe.each(KINDS)('%s', (kind) => {
    it('the source live referencing rows point at the survivor; a deleted row and another contact`s rows are left alone; one event per moved row', async () => {
      const survivor = await contact({ name: 'S' })
      const source = await contact({ name: 'R' })
      const other = await contact({ name: 'O' })
      const a = await make(kind, source.id, 'a')
      const b = await make(kind, source.id, 'b')
      const gone = await make(kind, source.id, 'gone')
      const theirs = await make(kind, other.id, 'other')
      const path = kind === 'custom' ? `/api/v1/${PROJECTS}` : `/api/v1/${kind}`
      expect((await k.call(owner, 'DELETE', `${path}/${gone}`)).status).toBe(204)
      const before = (await k.events(eventType(kind))).length
      const res = await merge(survivor.id, source.id)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect((await rowOf(table(kind), a))[column(kind)]).toBe(survivor.id)
      expect((await rowOf(table(kind), b))[column(kind)]).toBe(survivor.id)
      expect((await rowOf(table(kind), gone))[column(kind)]).toBe(source.id)
      expect((await rowOf(table(kind), theirs))[column(kind)]).toBe(other.id)
      const evs = (await k.events(eventType(kind))).slice(before)
      expect(evs.map((e) => e.resource_id).sort()).toEqual([a, b].sort())
      for (const e of evs) {
        const note = (e.before as any)[kind === 'custom' ? 'note' : 'note__c']
        expect((e.before as any)[column(kind)]).toBe(source.id)
        expect((e.after as any)[column(kind)]).toBe(survivor.id)
        // the row's other fields ride in both
        expect((e.after as any)[kind === 'custom' ? 'note' : 'note__c']).toBe(note)
        expect(['a', 'b']).toContain(note)
      }
    })
  })
})

describe('D21: the live check of a reference to contacts', () => {
  const code = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]
  const WRITES: Array<[string, string, (c: string) => Record<string, unknown>]> = [
    ['companies', '/api/v1/companies', (c) => ({ name: 'Co', contact__c: c })],
    ['deals', '/api/v1/deals', (c) => ({ name: 'D', contact__c: c })],
    ['tasks', '/api/v1/tasks', (c) => ({ title: 'T', contact__c: c })],
    ['custom', `/api/v1/${PROJECTS}`, (c) => ({ name: 'P', contact: c })],
  ]
  describe.each(WRITES)('a write on %s naming a contact', (kind, path, body) => {
    const bodyOf = async (c: string) => {
      const b = body(c)
      if (kind === 'deals') Object.assign(b, await baseBody(k, owner, 'deals'), { contact__c: c })
      return b
    }
    const send = async (c: string) => k.call(owner, 'POST', path, await bodyOf(c))
    it('passes for a live contact; a deleted and a merged contact are 400 invalid_reference', async () => {
      const live = await contact({ name: 'L' })
      expect((await send(live.id)).status).toBe(201)
      const deleted = await contact({ name: 'D' })
      expect((await k.call(owner, 'DELETE', `${CONTACTS}/${deleted.id}`)).status).toBe(204)
      expect(code(await send(deleted.id))).toEqual([400, 'invalid_reference'])
      const survivor = await contact({ name: 'S' })
      const merged = await contact({ name: 'M' })
      expect((await merge(survivor.id, merged.id)).status).toBe(200)
      expect(code(await send(merged.id))).toEqual([400, 'invalid_reference'])
      expect(code(await send('0190b2c4-0000-7000-8000-00000000dead'))).toEqual([400, 'invalid_reference'])
    })
    it('a contact deleted between the plan and the commit answers 409 conflict', async () => {
      const c = await contact({ name: 'Gone' })
      const b = await bodyOf(c.id)
      k.beforeCommit(async () => {
        await k.d1
          .prepare('update "contacts" set deleted_at = ? where id = ?')
          .bind('2026-11-06T10:00:00.000Z', c.id)
          .run()
      })
      expect(code(await k.call(owner, 'POST', path, b))).toEqual([409, 'conflict'])
    })
  })

  it('deleting a referenced contact leaves the reference in place (P5)', async () => {
    const c = await contact({ name: 'Ref' })
    const t = await k.call(owner, 'POST', '/api/v1/tasks', { title: 'T', contact__c: c.id })
    expect((await k.call(owner, 'DELETE', `${CONTACTS}/${c.id}`)).status).toBe(204)
    expect((await rowOf('tasks', t.body.id)).contact__c).toBe(c.id)
  })
})

describe('the catalog cannot drift from the database', () => {
  const fks = async () => {
    const tables = (
      (
        await k.d1
          .prepare(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'",
          )
          .all()
      ).results as Array<{ name: string }>
    ).map((t) => t.name)
    const out: string[] = []
    for (const t of tables)
      for (const f of (
        await k.d1
          .prepare(
            `select "from" as col from pragma_foreign_key_list('${t}') where "table" = 'contacts' and "from" <> 'organization_id'`,
          )
          .all()
      ).results as Array<{ col: string }>)
        out.push(`${t}.${f.col}`)
    return out.sort()
  }
  it('the foreign keys onto contacts equal the static entries, the derived ones and the exemptions', async () => {
    const derived = contactReferencesOf(k.registry.resources())
    expect(derived.map((r) => `${r.table}.${r.column}`).sort()).toEqual([
      'companies.contact__c',
      'deals.contact__c',
      'projects__c.contact',
      'tasks.contact__c',
    ])
    expect(await fks()).toEqual(
      [
        ...CONTACT_REFERENCES.map((r) => `${r.table}.${r.column}`),
        ...derived.map((r) => `${r.table}.${r.column}`),
        ...CONTACT_REFERENCE_EXEMPTIONS.map((r) => `${r.table}.${r.column}`),
      ].sort(),
    )
  })
  it('every derived entry is liveOnly and names the definition table and a real column', async () => {
    for (const r of contactReferencesOf(k.registry.resources())) {
      expect(r.liveOnly).toBe(true)
      expect(r.def.table).toBe(r.table)
      const cols = (
        (await k.d1.prepare(`select name from pragma_table_info('${r.table}')`).all()).results as Array<{
          name: string
        }>
      ).map((c) => c.name)
      expect(cols).toContain(r.column)
    }
  })

  const DRIFT: Array<[string, (source: string) => Promise<unknown>]> = [
    ['a task', (src) => k.call(owner, 'POST', '/api/v1/tasks', { title: 'Late', contact__c: src })],
    ['a custom object row', (src) => k.call(owner, 'POST', `/api/v1/${PROJECTS}`, { name: 'Late', contact: src })],
  ]
  it.each(DRIFT)(
    '%s referencing the source that appears between the plan and the commit aborts the merge: 409, nothing written',
    async (_label, make) => {
      const survivor = await contact({ name: 'S' })
      const source = await contact({ name: 'R', note__c: 'x' })
      k.beforeCommit(async () => {
        await make(source.id)
      })
      const res = await merge(survivor.id, source.id)
      expect([res.status, res.body?.error?.code]).toEqual([409, 'conflict'])
      expect((await rowOf('contacts', source.id)).deleted_at).toBeNull()
      expect((await rowOf('contacts', survivor.id)).note__c).toBeNull()
      expect(await k.events('contact.merged')).toHaveLength(0)
    },
  )
})

describe('the rail executes a proposed merge with the same catalog', () => {
  it('an approved contacts.merge proposal moves a declared reference and fills a __c field', async () => {
    const proposer = await k.actor('proposer', 'agent', ['contacts:request_approval', 'action_requests:read'])
    const survivor = await contact({ name: 'Same' })
    const source = await contact({ name: 'Same', note__c: 'from source' })
    const task = await k.call(owner, 'POST', '/api/v1/tasks', { title: 'T', contact__c: source.id })
    const proposed = await k.call(proposer, 'POST', '/api/v1/action-requests', {
      operation: 'contacts.merge',
      arguments: { id: survivor.id, source_id: source.id },
      reason: 'duplicate',
    })
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201)
    const approved = await k.call(owner, 'POST', `/api/v1/action-requests/${proposed.body.id}/approve`)
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body.status).toBe('executed')
    expect((await rowOf('tasks', task.body.id)).contact__c).toBe(survivor.id)
    expect((await rowOf('contacts', survivor.id)).note__c).toBe('from source')
  })
})
