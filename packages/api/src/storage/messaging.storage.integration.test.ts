import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defineOperation, step, unit, uuidv7, type PreparedOperation } from '@vault/storage'
import { eventSetStatement as eventSet } from '../outbox.js'
import { ApiError } from '../errors.js'
import { mergeOperation } from '../identity/merge.js'
import { companyFiles } from '../resources/company-files.js'
import { contactFiles } from '../resources/contact-files.js'
import { files } from '../resources/files.js'
import { contacts } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { interactions } from '../resources/interactions.js'
import { messages } from '../resources/messages.js'
import { threads } from '../resources/threads.js'
import { openEngines, type Engine } from '../test/engines.js'
import { foreignTenant, identityKit, type IdentityKit } from '../test/identity-kit.js'
import { seedConversation, type ConversationOpts } from '../test/messaging-kit.js'
import { afterOf, createOperation, deleteOperation, getOperation, listOperation } from './crud.js'
import type { PreparedResource } from './definition.js'

// CORE25 cycle 1 acceptance on both engines: records with embedded children, join filters, event `after` that carries
// the embeds, the link resources and their conflict/reference rules. Fixtures are direct inserts (P9).
let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('messaging resources on %s', (name) => {
  let e: Engine
  let k: IdentityKit
  const seed = (opts: ConversationOpts = {}) => seedConversation((table, row) => e.insert(table, row), opts)
  const get = (def: PreparedResource<any, any>, id: string) => k.get(def, id)
  const list = (def: PreparedResource<any, any>, filters: Record<string, string> = {}) => k.list(def, filters)
  const ids = (page: { data: Array<Record<string, any>> }) => page.data.map((r) => r.id as string).sort()
  const identityOf = async (value: string, contactId?: string) => {
    const contact = contactId ? { id: contactId } : await k.contact({})
    const identity = await k.identity({ kind: 'email', value, contact_id: contact.id })
    return { contactId: contact.id as string, identityId: identity.id as string }
  }
  const events = async (prefix: string) => (await e.rows('events')).filter((x) => String(x.type).startsWith(prefix))

  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    k = identityKit(e)
  })

  describe('records', () => {
    it('message record shape: attachments ordered by position, numbers and booleans decoded, hidden columns absent', async () => {
      const s = await seed({
        attachments: [
          { position: 2, size_bytes: 52_428_800, inline: true },
          { position: 0 },
          { position: 1, failed: true },
        ],
      })
      const m = await get(messages, s.messageId)
      expect(Object.keys(m).sort()).toEqual(
        ['id', 'thread_id', 'channel', 'kind', 'external_id', 'in_reply_to', 'author', 'occurred_at', 'preview', 'version', 'retracted_at', 'attachments', 'created_by', 'created_at'].sort(),
      )
      expect(m.author).toEqual({ user_id: 'jane@acme.test', user_name: 'jane@acme.test', full_name: 'Jane', is_bot: false })
      expect(m.version).toBe(1)
      expect(m.attachments.map((a: any) => a.position)).toEqual([0, 1, 2])
      expect(m.attachments[0]).toMatchObject({ type: 'file', fetch_status: 'stored', inline: false })
      expect(typeof m.attachments[0].size_bytes).toBe('number')
      expect(m.attachments[1]).toMatchObject({ fetch_status: 'failed', file_id: null })
      expect(m.attachments[2]).toMatchObject({ size_bytes: 52_428_800, inline: true })
      expect(typeof m.attachments[2].inline).toBe('boolean')
      for (const a of m.attachments) {
        expect(Object.keys(a).sort()).toEqual(['content_id', 'fetch_status', 'file_id', 'id', 'inline', 'mime_type', 'name', 'position', 'size_bytes', 'type'])
      }
    })

    it('a reaction has no attachments: [] and not null', async () => {
      const s = await seed({ kind: 'reaction' })
      expect((await get(messages, s.messageId)).attachments).toEqual([])
    })

    it('interaction record: participants ordered by role then identity id', async () => {
      const a = await identityOf('a@acme.test')
      const b = await identityOf('b@acme.test')
      const c = await identityOf('c@acme.test')
      const s = await seed({ participants: [{ identityId: b.identityId, role: 'to' }, { identityId: a.identityId, role: 'from' }, { identityId: c.identityId, role: 'cc' }] })
      const i = await get(interactions, s.interactionId!)
      expect(Object.keys(i).sort()).toEqual(['id', 'kind', 'channel', 'direction', 'occurred_at', 'thread_id', 'message_id', 'participants', 'created_by', 'created_at'].sort())
      expect(i.participants).toEqual([
        { identity_id: c.identityId, role: 'cc' },
        { identity_id: a.identityId, role: 'from' },
        { identity_id: b.identityId, role: 'to' },
      ])
      expect(i.message_id).toBe(s.messageId)
    })

    it('files record: size_bytes is a number, storage_key is absent', async () => {
      const s = await seed({ attachments: [{ position: 0, size_bytes: 52_428_800 }] })
      const f = await get(files, s.fileIds[0]!)
      expect(f.size_bytes).toBe(52_428_800)
      expect(typeof f.size_bytes).toBe('number')
      expect(Object.keys(f).sort()).toEqual(['id', 'name', 'mime_type', 'size_bytes', 'sha256', 'created_by', 'created_at'].sort())
    })

    it('threads record', async () => {
      const s = await seed({ subject: 'Hello' })
      const t = await get(threads, s.threadId)
      expect(Object.keys(t).sort()).toEqual(['id', 'channel', 'subject', 'created_by', 'created_at'].sort())
      expect(t).toMatchObject({ channel: 'email', subject: 'Hello' })
    })

    it('list embeds: every item carries its ordered attachments; the cursor is the keyset of every list', async () => {
      for (let i = 0; i < 3; i++) await seed({ attachments: [{ position: 1 }, { position: 0 }] })
      const page = await list(messages)
      expect(page.data).toHaveLength(3)
      for (const m of page.data) expect(m.attachments.map((a: any) => a.position)).toEqual([0, 1])
      const first = await k.run((env) => listOperation(messages, env, { limit: 2 }))
      expect(first.data).toHaveLength(2)
      expect(first.next_cursor).toBe(first.data[1]!.id)
      const second = await k.run((env) => listOperation(messages, env, { limit: 2, after: first.next_cursor! }))
      expect(second.data).toHaveLength(1)
      expect(second.next_cursor).toBeNull()
    })
  })

  describe('filters', () => {
    it('messages: thread_id, kind, external_id, in_reply_to', async () => {
      const t1 = await seed({ externalId: 'one@acme.test' })
      const t2 = await seed({ externalId: 'two@acme.test', kind: 'reaction', inReplyTo: 'one@acme.test' })
      const sameThread = await seed({ externalId: 'three@acme.test', threadId: t1.threadId })
      expect(ids(await list(messages, { thread_id: t1.threadId }))).toEqual([t1.messageId, sameThread.messageId].sort())
      expect(ids(await list(messages, { kind: 'reaction' }))).toEqual([t2.messageId])
      expect(ids(await list(messages, { external_id: 'two@acme.test' }))).toEqual([t2.messageId])
      expect(ids(await list(messages, { in_reply_to: 'one@acme.test' }))).toEqual([t2.messageId])
      expect(ids(await list(messages, { channel: 'email' }))).toHaveLength(3)
      expect(ids(await list(threads, { channel: 'email' }))).toHaveLength(2)
    })

    it('interactions: column filters', async () => {
      const a = await seed({ direction: 'inbound' })
      const b = await seed({ direction: 'outbound' })
      expect(ids(await list(interactions, { direction: 'outbound' }))).toEqual([b.interactionId])
      expect(ids(await list(interactions, { thread_id: a.threadId }))).toEqual([a.interactionId])
      expect(ids(await list(interactions, { message_id: b.messageId }))).toEqual([b.interactionId])
    })

    it('files: sha256', async () => {
      const s = await seed({ attachments: 2 })
      const f = await get(files, s.fileIds[0]!)
      expect(ids(await list(files, { sha256: f.sha256 }))).toEqual([s.fileIds[0]])
    })

    it('join filter identity_id, also upper-cased', async () => {
      const a = await identityOf('a@acme.test')
      const b = await identityOf('b@acme.test')
      const c = await identityOf('c@acme.test')
      const i1 = await seed({ participants: [{ identityId: a.identityId, role: 'from' }, { identityId: b.identityId, role: 'to' }] })
      await seed({ participants: [{ identityId: c.identityId, role: 'from' }] })
      expect(ids(await list(interactions, { identity_id: b.identityId }))).toEqual([i1.interactionId])
      expect(ids(await list(interactions, { identity_id: b.identityId.toUpperCase() }))).toEqual([i1.interactionId])
    })

    describe('join filter contact_id', () => {
      let K: string
      let A: string
      let A2: string
      let i1: string
      let i2: string
      let i3: string
      beforeEach(async () => {
        const a = await identityOf('a@acme.test')
        K = a.contactId
        A = a.identityId
        A2 = (await identityOf('a2@acme.test', K)).identityId
        const other = await identityOf('other@acme.test')
        i1 = (await seed({ participants: [{ identityId: A, role: 'from' }] })).interactionId!
        i2 = (await seed({ participants: [{ identityId: A2, role: 'to' }] })).interactionId!
        i3 = (await seed({ participants: [{ identityId: other.identityId, role: 'from' }] })).interactionId!
      })

      it('finds interactions of any live identity of the contact', async () => {
        expect(ids(await list(interactions, { contact_id: K }))).toEqual([i1, i2].sort())
        expect(i3).toBeDefined()
      })

      it('follows a merge: the survivor owns the interactions, the tombstoned source none', async () => {
        const S = await k.contact({})
        await k.run((env) => mergeOperation(env, S.id, K))
        expect(ids(await list(interactions, { contact_id: S.id }))).toEqual([i1, i2].sort())
        expect(ids(await list(interactions, { contact_id: K }))).toEqual([])
      })

      it('ignores a deleted identity', async () => {
        await k.run((env) => deleteOperation(identities, env, A2))
        expect(ids(await list(interactions, { contact_id: K }))).toEqual([i1])
      })

      it('a bad value is 400 validation_error', () => {
        let err: unknown
        try {
          k.env()
          listOperation(interactions, k.env(), { filters: { contact_id: 'nope' } })
        } catch (x) {
          err = x
        }
        expect(err).toBeInstanceOf(ApiError)
        expect(err).toMatchObject({ status: 400, code: 'validation_error' })
      })
    })

    if (name === 'postgres') {
      it('a join filter never reaches another organisation (the foreign identity and interaction exist)', async () => {
        const f = await foreignTenant(e)
        const contact = await f.run(createOperation(contacts, f.env(), {}))
        const identity = await f.run(createOperation(identities, f.env(), { kind: 'email', value: 'x@foreign.test', contact_id: contact.id }))
        const foreignInsert = (table: string, row: Record<string, unknown>) => e.insert(table, { ...row, organization_id: f.organizationId, created_by: f.userId })
        await seedConversation(foreignInsert, { participants: [{ identityId: identity.id, role: 'from' }] })
        expect(ids(await list(interactions, { identity_id: identity.id }))).toEqual([])
        expect(ids(await list(interactions, { contact_id: contact.id }))).toEqual([])
      })
    }
  })

  describe('events carry the embeds in `after`', () => {
    const setEvent = (def: PreparedResource<any, any>, resourceId: string, eventId: string): PreparedOperation<null> =>
      defineOperation<null>({
        name: 'test.event_after',
        mutates: true,
        reads: () => ({}),
        build: (_found, qc) =>
          unit({
            steps: [
              step(eventSet(qc, { at: '2026-10-28T10:00:00.000Z', organizationId: e.organizationId, actorId: e.userId, type: `${def.eventName}.updated`, resourceType: def.eventName, after: afterOf(def), rows: [{ eventId, resourceId, before: null }] }), 'first-event'),
            ],
            events: [{ id: eventId, type: `${def.eventName}.updated`, resourceType: def.eventName, resourceId }],
            decode: () => null,
          }),
      })

    it('a message: after deep-equals the get record, attachments ordered', async () => {
      const s = await seed({ attachments: [{ position: 1 }, { position: 0, size_bytes: 52_428_800 }] })
      const eventId = uuidv7()
      await e.run(setEvent(messages, s.messageId, eventId))
      const ev = (await e.rows('events')).find((x) => x.id === eventId)!
      expect(ev.after).toEqual(await get(messages, s.messageId))
      expect(ev.after.attachments.map((a: any) => a.position)).toEqual([0, 1])
      expect(typeof ev.after.attachments[0].inline).toBe('boolean')
    })

    it('an interaction: after deep-equals the get record', async () => {
      const a = await identityOf('a@acme.test')
      const b = await identityOf('b@acme.test')
      const s = await seed({ participants: [{ identityId: b.identityId, role: 'to' }, { identityId: a.identityId, role: 'from' }] })
      const eventId = uuidv7()
      await e.run(setEvent(interactions, s.interactionId!, eventId))
      const ev = (await e.rows('events')).find((x) => x.id === eventId)!
      expect(ev.after).toEqual(await get(interactions, s.interactionId!))
      expect(ev.after.participants).toHaveLength(2)
    })
  })

  describe.each([
    { label: 'contact', def: (): PreparedResource<any, any> => contactFiles, table: 'contact_files', col: 'contact_id', ev: 'contact_file', parent: async () => (await k.contact({})).id as string },
    { label: 'company', def: (): PreparedResource<any, any> => companyFiles, table: 'company_files', col: 'company_id', ev: 'company_file', parent: async () => (await k.company({ name: 'Co' })).id as string },
  ])('$label links', ({ def, table, col, ev, parent }) => {
    const create = (body: Record<string, unknown>) => k.run((env) => createOperation(def(), env, body))
    const remove = (id: string) => k.run((env) => deleteOperation(def(), env, id))
    const fileOf = async () => (await seed({ attachments: 1 })).fileIds[0]!

    it('create: 201-shaped record, one event with the caller as actor, every stamp the clock', async () => {
      const P = await parent()
      const F = await fileOf()
      const before = (await events(ev)).length
      const r = await create({ [col]: P, file_id: F })
      expect(Object.keys(r).sort()).toEqual(['id', col, 'file_id', 'created_by', 'created_at', 'updated_at'].sort())
      expect(r).toMatchObject({ [col]: P, file_id: F, created_by: e.userId })
      expect(r.created_at).toBe(r.updated_at)
      const evs = await events(ev)
      expect(evs).toHaveLength(before + 1)
      expect(evs.at(-1)).toMatchObject({ type: `${ev}.created`, resource_id: r.id, actor_id: e.userId, after: r, created_at: r.created_at })
    })

    it('a duplicate live link is 409 link_exists, with no row and no event', async () => {
      const P = await parent()
      const F = await fileOf()
      const first = await create({ [col]: P, file_id: F })
      const rows = (await e.rows(table)).length
      const evs = (await e.rows('events')).length
      const err = await k.fail((env) => createOperation(def(), env, { [col]: P, file_id: F }))
      expect([err.status, err.code]).toEqual([409, 'link_exists'])
      expect(err.message).toBe(`a live link to file ${F} already exists (${first.id})`)
      expect((await e.rows(table)).length).toBe(rows)
      expect((await e.rows('events')).length).toBe(evs)
    })

    it('after a soft delete a new link is created (delete: before is the record, after null)', async () => {
      const P = await parent()
      const F = await fileOf()
      const first = await create({ [col]: P, file_id: F })
      await remove(first.id)
      expect((await e.rows(table)).find((x) => x.id === first.id)!.deleted_at).not.toBeNull()
      const del = (await events(ev)).find((x) => x.type === `${ev}.deleted`)!
      expect(del).toMatchObject({ resource_id: first.id, after: null, before: first })
      expect(await create({ [col]: P, file_id: F })).toMatchObject({ [col]: P })
      // the deleted link is gone from get and list
      await expect(k.fail((env) => getOperation(def(), env, first.id))).resolves.toMatchObject({ status: 404 })
      expect((await list(def(), { [col]: P })).data).toHaveLength(1)
    })

    it('invalid references are 400 invalid_reference and write nothing', async () => {
      const F = await fileOf()
      const P = await parent()
      const deleted = await parent()
      await (col === 'contact_id' ? k.deleteContact(deleted) : k.deleteCompany(deleted))
      const rows = (await e.rows(table)).length
      const evs = (await e.rows('events')).length
      for (const body of [{ [col]: deleted, file_id: F }, { [col]: P, file_id: uuidv7() }, { [col]: uuidv7(), file_id: F }]) {
        const err = await k.fail((env) => createOperation(def(), env, body))
        expect([err.status, err.code]).toEqual([400, 'invalid_reference'])
      }
      expect((await e.rows(table)).length).toBe(rows)
      expect((await e.rows('events')).length).toBe(evs)
    })

    if (name === 'postgres') {
      it("another organisation's file is invalid_reference", async () => {
        const f = await foreignTenant(e)
        const foreign = await seedConversation((t, row) => e.insert(t, { ...row, organization_id: f.organizationId, created_by: f.userId }), { attachments: 1 })
        const P = await parent()
        const err = await k.fail((env) => createOperation(def(), env, { [col]: P, file_id: foreign.fileIds[0] }))
        expect([err.status, err.code]).toEqual([400, 'invalid_reference'])
      })
    }

    if (name === 'd1') {
      it('D1 race backstop: a link inserted between plan and commit is 409 conflict, one row, no event of this unit', async () => {
        const P = await parent()
        const F = await fileOf()
        const evs = (await e.rows('events')).length
        e.betweenPlanAndCommit(async () => {
          await e.insert(table, { [col]: P, file_id: F })
        })
        const err = await k.fail((env) => createOperation(def(), env, { [col]: P, file_id: F }))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect((await e.rows(table)).filter((x) => x[col] === P)).toHaveLength(1)
        expect((await e.rows('events')).length).toBe(evs)
      })
    }
  })
})
