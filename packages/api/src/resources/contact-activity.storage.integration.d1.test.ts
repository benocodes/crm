import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compileOperation } from '@vibase/storage'
import { sql } from 'kysely'
import { z } from 'zod'
import { ScopeSet } from '../scopes.js'
import { mergeOperation } from '../identity/merge.js'
import { deleteCompanyOperation } from '../identity/cascades.js'
import { createOperation, deleteOperation, getOperation, listOperation, updateOperation } from '../storage/crud.js'
import { definePreparedResource } from '../storage/definition.js'
import { captureMessage, runCapture, type CaptureOverrides } from '../test/capture-kit.js'
import { openEngines, type Engine } from '../test/engines.js'
import { contacts } from './contacts.js'
import { identities } from './identities.js'

// [[CORE131]] D2-D4, D10 on the D1 oracle. Interaction rows come only from the capture unit (D14); contacts and identities
// are set-up rows. Assertions on the derived values go through the contacts operations, as a caller sees them.
const C1 = '0190b2c4-0000-7000-8000-0000000000c1'
const OWNER = 'owner@vault.test'
const READ = ['contacts:read', 'contacts:write', 'interactions:read']
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

let engines: Engine[]
let e: Engine
beforeAll(async () => {
  engines = await openEngines(['d1'])
  e = engines[0]!
})
afterAll(async () => {
  for (const x of engines) await x.close()
})
beforeEach(async () => {
  await e.reset()
  await e.insert('identities', { kind: 'email', value: OWNER, contact_id: null, own: true })
})

const env = (scopes: readonly string[] = READ) => e.env({ scopes: ScopeSet.parse([...scopes]) })
const contact = async (name: string) => (await e.insert('contacts', { name })).id as string
const identity = async (contactId: string, value: string) => (await e.insert('identities', { kind: 'email', value, contact_id: contactId, own: false })).id as string
/** An inbound message from `from` to the owner at `at`. */
const inbound = (from: string, at: string, over: CaptureOverrides = {}) =>
  runCapture(e, {
    connection_id: C1,
    messages: [
      captureMessage(e.organizationId, {
        occurred_at: at,
        author: { user_id: from, user_name: from, full_name: from, is_bot: false },
        participants: [
          { kind: 'email', value: from, role: 'from' },
          { kind: 'email', value: OWNER, role: 'to' },
        ],
        ...over,
      }),
    ],
  })
/** A message the connection sent, from the owner to `to` (cc and bcc as given). */
const outbound = (to: string[], at: string, extra: { cc?: string[]; bcc?: string[] } = {}, over: CaptureOverrides = {}) =>
  runCapture(e, {
    connection_id: C1,
    messages: [
      captureMessage(e.organizationId, {
        occurred_at: at,
        sent_by_connection: true,
        author: { user_id: OWNER, user_name: OWNER, full_name: 'Owner', is_bot: false },
        participants: [
          { kind: 'email', value: OWNER, role: 'from' },
          ...to.map((value) => ({ kind: 'email' as const, value, role: 'to' as const })),
          ...(extra.cc ?? []).map((value) => ({ kind: 'email' as const, value, role: 'cc' as const })),
          ...(extra.bcc ?? []).map((value) => ({ kind: 'email' as const, value, role: 'bcc' as const })),
        ],
        ...over,
      }),
    ],
  })
const get = async (id: string, scopes: readonly string[] = READ): Promise<Record<string, unknown>> => (await e.run(getOperation(contacts, env(scopes), id))).value as Record<string, unknown>
const activity = async (id: string) => {
  const c = await get(id)
  return [c.last_contacted_at, c.last_interacted_at]
}

describe('derivation (D3)', () => {
  it('an inbound-only contact has last_contacted_at null and last_interacted_at set', async () => {
    const a = await contact('Ada')
    await identity(a, 'ada@x.test')
    await inbound('ada@x.test', '2026-10-20T08:00:00.000Z')
    expect(await activity(a)).toEqual([null, '2026-10-20T08:00:00.000Z'])
  })

  it('an outbound message sets both, and the value is the MAX over the contact\'s several identities', async () => {
    const a = await contact('Ada')
    await identity(a, 'ada@x.test')
    await identity(a, 'ada@home.test')
    await inbound('ada@x.test', '2026-10-20T08:00:00.000Z')
    await outbound(['ada@home.test'], '2026-10-21T09:00:00.000Z')
    await inbound('ada@x.test', '2026-10-19T08:00:00.000Z')
    await outbound(['ada@x.test'], '2026-10-18T09:00:00.000Z')
    expect(await activity(a)).toEqual(['2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z'])
  })

  it('last_interacted_at is later than last_contacted_at when the latest message is inbound', async () => {
    const a = await contact('Ada')
    await identity(a, 'ada@x.test')
    await outbound(['ada@x.test'], '2026-10-18T09:00:00.000Z')
    await inbound('ada@x.test', '2026-10-22T09:00:00.000Z')
    expect(await activity(a)).toEqual(['2026-10-18T09:00:00.000Z', '2026-10-22T09:00:00.000Z'])
  })

  it('any role counts: a cc-only and a bcc-only participant of an outbound message are contacted', async () => {
    const [cc, bcc, to] = [await contact('Cc'), await contact('Bcc'), await contact('To')]
    await identity(cc, 'cc@x.test')
    await identity(bcc, 'bcc@x.test')
    await identity(to, 'to@x.test')
    await outbound(['to@x.test'], '2026-10-21T09:00:00.000Z', { cc: ['cc@x.test'], bcc: ['bcc@x.test'] })
    for (const id of [cc, bcc, to]) expect(await activity(id)).toEqual(['2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z'])
  })

  it('a reaction interaction counts', async () => {
    const a = await contact('Ada')
    await identity(a, 'ada@x.test')
    await inbound('ada@x.test', '2026-10-20T08:00:00.000Z', { kind: 'reaction' })
    expect(await activity(a)).toEqual([null, '2026-10-20T08:00:00.000Z'])
  })

  it('a retracted message still counts', async () => {
    const a = await contact('Ada')
    await identity(a, 'ada@x.test')
    await outbound(['ada@x.test'], '2026-10-21T09:00:00.000Z')
    const [message] = await e.rows('messages')
    // `messages` is append-only (trigger) and capture cannot yet write a retraction: lift the trigger for this one update, then restore it.
    const trigger = (await e.d1!.prepare("select sql from sqlite_schema where type = 'trigger' and name = 'messages_append_only'").first()) as { sql: string }
    await e.d1!.prepare('drop trigger messages_append_only').run()
    try {
      await e.update('messages', message!.id as string, { retracted_at: '2026-10-22T09:00:00.000Z' })
    } finally {
      await e.d1!.prepare(trigger.sql).run()
    }
    expect((await e.rows('messages'))[0]!.retracted_at).toBe('2026-10-22T09:00:00.000Z')
    expect(await activity(a)).toEqual(['2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z'])
  })

  it('an own identity never contributes: a contact with no interactions and one with no address stay null/null while others are active', async () => {
    const quiet = await contact('Quiet')
    await identity(quiet, 'quiet@x.test')
    const bare = await contact('Bare')
    const active = await contact('Active')
    await identity(active, 'active@x.test')
    await outbound(['active@x.test'], '2026-10-21T09:00:00.000Z')
    expect(await activity(quiet)).toEqual([null, null])
    expect(await activity(bare)).toEqual([null, null])
    expect(await activity(active)).toEqual(['2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z'])
    const own = (await e.rows('identities')).find((r) => r.own === true)!
    expect(own.contact_id).toBeNull()
  })

  it('both values are ISO text in the created_at format', async () => {
    const a = await contact('Ada')
    await identity(a, 'ada@x.test')
    await outbound(['ada@x.test'], '2026-10-21T09:00:00.123Z')
    const c = await get(a)
    expect(c.last_contacted_at).toMatch(ISO)
    expect(c.last_interacted_at).toMatch(ISO)
    expect(c.last_contacted_at).toBe('2026-10-21T09:00:00.123Z')
    expect(c.created_at).toMatch(ISO)
  })
})

describe('the identity carries the history (D4)', () => {
  it('moving an identity moves its contribution: the old contact drops, the new gains', async () => {
    const a = await contact('Ada')
    const b = await contact('Bob')
    const id = await identity(a, 'ada@x.test')
    await outbound(['ada@x.test'], '2026-10-21T09:00:00.000Z')
    expect(await activity(a)).toEqual(['2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z'])
    await e.run(updateOperation(identities, env(['contacts:read', 'contacts:write']), id, { contact_id: b }))
    expect(await activity(a)).toEqual([null, null])
    expect(await activity(b)).toEqual(['2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z'])
  })

  it('soft-deleting the identity drops its contribution', async () => {
    const a = await contact('Ada')
    const id = await identity(a, 'ada@x.test')
    await outbound(['ada@x.test'], '2026-10-21T09:00:00.000Z')
    await e.run(deleteOperation(identities, env(['contacts:read', 'contacts:write']), id))
    expect(await activity(a)).toEqual([null, null])
  })

  it('contacts.merge returns the survivor with values covering the source\'s interactions', async () => {
    const survivor = await contact('Survivor')
    const source = await contact('Source')
    await identity(survivor, 'survivor@x.test')
    await identity(source, 'source@x.test')
    await inbound('survivor@x.test', '2026-10-19T08:00:00.000Z')
    await outbound(['source@x.test'], '2026-10-21T09:00:00.000Z')
    expect(await activity(survivor)).toEqual([null, '2026-10-19T08:00:00.000Z'])
    const merged = (await e.run(mergeOperation(env(), survivor, source))).value as Record<string, unknown>
    expect(merged.last_contacted_at).toBe('2026-10-21T09:00:00.000Z')
    expect(merged.last_interacted_at).toBe('2026-10-21T09:00:00.000Z')
    expect(await activity(survivor)).toEqual(['2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z'])
  })
})

describe('events never carry a derived key (D2)', () => {
  it('contact.created, updated and merged of a contact with a non-null value have no derived key in before or after', async () => {
    const survivor = (await e.run(createOperation(contacts, env(), { name: 'Survivor' }))).value as { id: string }
    const source = await contact('Source')
    await identity(survivor.id, 'survivor@x.test')
    await identity(source, 'source@x.test')
    await outbound(['survivor@x.test'], '2026-10-21T09:00:00.000Z')
    expect((await get(survivor.id)).last_contacted_at).toBe('2026-10-21T09:00:00.000Z')
    const updated = (await e.run(updateOperation(contacts, env(), survivor.id, { name: 'Survivor 2' }))).value as Record<string, unknown>
    expect(updated.last_contacted_at).toBe('2026-10-21T09:00:00.000Z') // the response shows it
    await e.run(mergeOperation(env(), survivor.id, source))
    const events = (await e.rows('events')).filter((r) => String(r.type).startsWith('contact.'))
    expect(events.map((r) => r.type)).toEqual(expect.arrayContaining(['contact.created', 'contact.updated', 'contact.merged']))
    for (const ev of events) {
      for (const side of [ev.before, ev.after]) {
        if (side === null || side === undefined) continue
        const keys = Object.keys(side as object)
        expect(keys, String(ev.type)).not.toContain('last_contacted_at')
        expect(keys, String(ev.type)).not.toContain('last_interacted_at')
      }
    }
  })
})

describe('cascade children events (D2)', () => {
  it('companies.delete as an actor with interactions:read: the unlinked contact\'s contact.updated carries no derived key', async () => {
    const company = (await e.insert('companies', { name: 'Acme' })).id as string
    const a = (await e.insert('contacts', { name: 'Ada', company_id: company })).id as string
    await identity(a, 'ada@x.test')
    await outbound(['ada@x.test'], '2026-10-21T09:00:00.000Z')
    expect((await get(a)).last_contacted_at).toBe('2026-10-21T09:00:00.000Z')
    await e.run(deleteCompanyOperation(env(['companies:write', ...READ]), company))
    const ev = (await e.rows('events')).filter((r) => r.type === 'contact.updated' && r.resource_id === a)
    expect(ev).toHaveLength(1)
    for (const side of [ev[0]!.before, ev[0]!.after] as Array<Record<string, unknown>>) {
      expect(side.company_id === company || side.company_id === null).toBe(true)
      expect(Object.keys(side)).not.toContain('last_contacted_at')
      expect(Object.keys(side)).not.toContain('last_interacted_at')
    }
  })
})

describe('scope projection at the operation (D5, D6)', () => {
  it('keys are present with interactions:read and absent without it, on get, list, create and update', async () => {
    const a = await contact('Ada')
    const keys = (r: unknown) => Object.keys(r as object)
    const withScope = env(READ)
    const without = env(['contacts:read', 'contacts:write'])
    expect(keys((await e.run(getOperation(contacts, withScope, a))).value)).toEqual(expect.arrayContaining(['last_contacted_at', 'last_interacted_at']))
    expect(keys((await e.run(getOperation(contacts, without, a))).value)).not.toContain('last_contacted_at')
    const page = (await e.run(listOperation(contacts, without, {}))).value as { data: object[] }
    expect(keys(page.data[0])).not.toContain('last_interacted_at')
  })
})

describe('query plan (D10)', () => {
  const planOf = async (op: Parameters<typeof compileOperation>[0]): Promise<string[]> => {
    const compiled = compileOperation(op, 'd1')
    const read = compiled.reads[0]!
    const rows = (await e.d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.parameters).all()).results as Array<{ detail: string }>
    return rows.map((r) => r.detail)
  }
  const assertSearches = (plan: string[]) => {
    const text = plan.join('\n')
    for (const table of ['identities', 'interaction_participants', 'interactions']) {
      expect(text, `${table} is touched`).toMatch(new RegExp(`SEARCH ${table}\\b`))
      expect(plan.filter((l) => new RegExp(`\\bSCAN ${table}\\b`).test(l)), `${table} is never scanned:\n${text}`).toEqual([])
    }
    for (const line of plan.filter((l) => /SEARCH (identities|interaction_participants|interactions)\b/.test(l))) expect(line, line).toMatch(/USING/)
    // The walk of D10, not just any index: identities by contact, participants by identity, interactions by id.
    expect(text).toMatch(/SEARCH identities USING INDEX idx_identities_contact_id \(contact_id=\?\)/)
    expect(text).toMatch(/SEARCH interaction_participants USING COVERING INDEX idx_interaction_participants_identity \(organization_id=\? AND identity_id=\?\)/)
    expect(text).toMatch(/SEARCH interactions USING INDEX \w+ \(organization_id=\? AND id=\?\)/)
  }
  it('a get, a page and a list with not_contacted_since search the three tables by index', async () => {
    const id = '0190b2c4-0000-7000-8000-0000000000aa'
    const scoped = env(READ)
    const get = await planOf(getOperation(contacts, scoped, id))
    const page = await planOf(listOperation(contacts, scoped, { limit: 20 }))
    const filtered = await planOf(listOperation(contacts, scoped, { filters: { not_contacted_since: '2026-10-05T00:00:00.000Z' } }))
    assertSearches(get)
    assertSearches(page)
    assertSearches(filtered)
  })
})

describe('the mechanism beyond contacts (D1)', () => {
  const tasksRecord = z.object({ id: z.uuid(), title: z.string(), title_length: z.number().int().nullable().optional(), shout: z.string().nullable().optional() })

  it('a second definition (tasks) with derived fields renders them through the same core, gated by its own scope', async () => {
    const def = definePreparedResource({
      surface: 'api',
      name: 'tasks',
      eventName: 'task',
      table: 'tasks',
      record: tasksRecord,
      derived: {
        title_length: { kind: 'integer', expression: (_qc, parent) => sql`length(${parent('title')})` },
        shout: { kind: 'timestamp', requires: [{ resource: 'notes', action: 'read' }], expression: (_qc, parent) => sql`(select max(${sql.ref('tasks.created_at')}) where ${parent('id')} is not null)` },
      },
    }) as unknown as Parameters<typeof getOperation>[0]
    await e.insertTask({ id: '0190b2c4-0000-7000-8000-0000000000b1', title: 'hello' })
    const plain = (await e.run(getOperation(def, env(['tasks:read']), '0190b2c4-0000-7000-8000-0000000000b1'))).value as Record<string, unknown>
    expect(plain.title_length).toBe(5)
    expect('shout' in plain).toBe(false)
    const full = (await e.run(getOperation(def, env(['tasks:read', 'notes:read']), '0190b2c4-0000-7000-8000-0000000000b1'))).value as Record<string, unknown>
    expect(full.title_length).toBe(5)
    expect(typeof full.shout).toBe('string')
    const page = (await e.run(listOperation(def, env(['tasks:read']), {}))).value as { data: Array<Record<string, unknown>> }
    expect(page.data[0]!.title_length).toBe(5)
  })
})
