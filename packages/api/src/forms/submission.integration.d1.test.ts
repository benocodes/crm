import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CommitOutcomeUnknown, StatementFailed, UnitDriftError, uuidv7, type PreparedOperation } from '@vibase/storage'
import { memoryObjectStore } from '../objects/store.js'
import { openD1Engine, SEED_AT, type Engine } from '../test/engines.js'
import { recordingObjectStore, type RecordingStore } from '../test/objects.js'
import { nodeStreams } from '../test/streams.js'
import { ApiError } from '../errors.js'
import { createApp } from '../rest/app.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import type { FormIngress } from './ingress-read.js'
import { formSubmitter, type FormAnswer, type FormSubmissionInput } from './map-submission.js'
import { captureFormSubmission, formSubmitterBlocked, type FormSubmissionContext } from './submission.js'

// [[CHN428]]: the form submission capture unit through the real D1 capture program (Miniflare), D1 only.
const NOW = '2026-11-18T09:00:00.000Z'
let e: Engine
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})

let objects: RecordingStore
let n = 0
beforeEach(async () => {
  await e.reset()
  objects = recordingObjectStore(memoryObjectStore())
})

async function seedForm(over: Partial<FormIngress> = {}): Promise<FormIngress> {
  n++
  const id = `0190b2c4-0000-7000-8000-0000000e${String(n).padStart(4, '0')}`
  await e.insert('principals', { id, kind: 'agent', created_at: SEED_AT })
  await e.insert('agents', { id, name: `Form agent ${n}`, scopes: [] })
  const form: FormIngress = {
    form_id: id,
    organization_id: e.organizationId,
    name: `Website ${n}`,
    enabled: true,
    allowed_origins: ['https://site.test'],
    email_field: 'email',
    phone_field: 'phone',
    name_field: 'name',
    consent_text: null,
    tag_ids: [],
    ...over,
  }
  await e.insert('forms', {
    id,
    name: form.name,
    public_id: `frm_${String(n).padStart(26, 'a')}`,
    enabled: true,
    email_field: form.email_field,
    phone_field: form.phone_field,
    name_field: form.name_field,
    consent_text: form.consent_text,
  })
  return form
}
const tag = async (over: Record<string, unknown> = {}) =>
  (await e.insert('tags', { name: `Tag ${++n}`, ...over })).id as string
const f = (name: string, value: string | string[]): FormAnswer => ({ name, value })
const ctxOf = (over: Partial<FormSubmissionContext> = {}): FormSubmissionContext => ({
  binding: e.binding,
  organizationId: e.organizationId,
  objects,
  streams: nodeStreams(),
  clock: () => new Date(NOW),
  newId: () => uuidv7(new Date(NOW)),
  randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
  ...over,
})
const inputOf = (
  form: FormIngress,
  fields: FormAnswer[],
  over: Partial<FormSubmissionInput> = {},
): FormSubmissionInput => ({
  form,
  public_id: 'frm_x',
  fields,
  consent_given: false,
  anonymous_id: null,
  origin: 'https://site.test',
  content_type: 'application/json',
  received_at: NOW,
  submission_id: uuidv7(new Date(NOW)),
  ...over,
})
const submit = (form: FormIngress, fields: FormAnswer[], over: Partial<FormSubmissionInput> = {}, ctx = ctxOf()) =>
  captureFormSubmission(ctx, inputOf(form, fields, over))
const eventTypes = async () => (await e.rows('events')).map((r) => String(r.type))
const bodyOf = async (contentKey: string) =>
  new TextDecoder().decode(
    new Uint8Array(await new Response((await objects.get(`${contentKey}/v1/body.md`))!.body).arrayBuffer()),
  )

/** The engine's binding with every `forms.capture_submission` execution observed and faults injected (the pipeline suite's pattern). */
function instrument(
  faults: { drift?: (n: number) => boolean; unique?: (n: number) => boolean; unknown?: boolean } = {},
) {
  let count = 0
  const runtime = {
    ...e.binding.runtime,
    execute: ((identity: any, op: PreparedOperation<unknown>) => {
      if (op.name !== 'forms.capture_submission') return e.binding.runtime.execute(identity, op)
      count++
      const at = count
      if (faults.unknown) return Promise.reject(new CommitOutcomeUnknown(op.name, new Error('lost')))
      return e.binding.runtime.execute(identity, {
        ...op,
        build: (found, qc) => {
          const built = op.build(found, qc)
          if (faults.drift?.(at)) throw new UnitDriftError(op.name)
          if (faults.unique?.(at)) throw new StatementFailed(op.name, 'unique', new Error('UNIQUE constraint failed'))
          return built
        },
      })
    }) as typeof e.binding.runtime.execute,
  }
  return { binding: { ...e.binding, runtime } as typeof e.binding, executions: () => count }
}

describe('a first and a repeat submission (D8, D9, D13, D18)', () => {
  it('a new address: one unit writes identity, contact, thread, message, interaction, participant and form-keyed sources, all as the form principal', async () => {
    const form = await seedForm()
    const submissionId = uuidv7(new Date(NOW))
    const out = await submit(form, [f('email', 'Jane@Acme.test'), f('name', 'Jane Roe'), f('note', 'Hi')], {
      submission_id: submissionId,
    })
    expect(out.new_thread).toBe(true)

    const identity = (await e.rows('identities')).find((r) => r.value === 'jane@acme.test')!
    expect(identity).toMatchObject({ kind: 'email', own: false, created_by: form.form_id })
    const contact = (await e.rows('contacts')).find((r) => r.id === identity.contact_id)!
    expect(contact).toMatchObject({ name: 'Jane Roe', created_by: form.form_id })
    expect(await e.rows('threads')).toEqual([
      expect.objectContaining({ id: out.thread_id, channel: 'form', subject: form.name, created_by: form.form_id }),
    ])
    const [message] = await e.rows('messages')
    expect(message).toMatchObject({
      id: out.message_id,
      channel: 'form',
      kind: 'message',
      external_id: submissionId,
      created_by: form.form_id,
    })
    expect(await e.rows('interactions')).toEqual([
      expect.objectContaining({
        id: out.interaction_id,
        channel: 'form',
        kind: 'message',
        direction: 'inbound',
        created_by: form.form_id,
      }),
    ])
    expect(await e.rows('interaction_participants')).toEqual([
      expect.objectContaining({ interaction_id: out.interaction_id, identity_id: identity.id, role: 'from' }),
    ])
    expect(await e.rows('message_sources')).toEqual([
      expect.objectContaining({
        form_id: form.form_id,
        connection_id: null,
        provider_message_id: submissionId,
        provider_thread_id: 'email:jane@acme.test',
      }),
    ])
    expect(await e.rows('thread_sources')).toEqual([
      expect.objectContaining({
        form_id: form.form_id,
        connection_id: null,
        provider_thread_id: 'email:jane@acme.test',
      }),
    ])

    const events = await e.rows('events')
    expect(events.map((r) => r.type)).toEqual([
      'contact.created',
      'identity.created',
      'thread.created',
      'message.created',
      'interaction.created',
    ])
    expect(events.every((r) => r.actor_id === form.form_id)).toBe(true)
    // messages.content reads this key: the body is what the mapper rendered.
    expect(await bodyOf(String(message!.content_key))).toBe(
      '**email:** Jane\\@Acme.test\n\n**name:** Jane Roe\n\n**note:** Hi\n',
    )
    expect(objects.writes.map((w) => w.key.split('/').slice(-2).join('/')).sort()).toEqual([
      'v1/body.md',
      'v1/original.json',
    ])
  })

  it('the same address on the same form joins the thread: no new contact or identity; another form or another address opens another thread', async () => {
    const a = await seedForm()
    const b = await seedForm()
    const first = await submit(a, [f('email', 'jane@acme.test')])
    const again = await submit(a, [f('email', 'JANE@acme.test')])
    expect(again.thread_id).toBe(first.thread_id)
    expect(again.new_thread).toBe(false)
    expect(await e.rows('messages')).toHaveLength(2)
    expect(await e.rows('threads')).toHaveLength(1)
    expect(await e.rows('contacts')).toHaveLength(1)
    expect(await e.rows('identities')).toHaveLength(1)
    expect(await e.rows('interactions')).toHaveLength(2)

    const otherForm = await submit(b, [f('email', 'jane@acme.test')])
    const otherAddress = await submit(a, [f('email', 'joe@acme.test')])
    expect(new Set([first.thread_id, otherForm.thread_id, otherAddress.thread_id]).size).toBe(3)
    expect(await e.rows('threads')).toHaveLength(3)
    expect(await e.rows('contacts')).toHaveLength(2)
  })

  it('a phone submitter keys the thread by phone, and the thread subject is the form name at the first submission', async () => {
    const form = await seedForm({ email_field: null })
    await submit(form, [f('phone', '+14155550100')])
    expect(await e.rows('thread_sources')).toEqual([
      expect.objectContaining({ provider_thread_id: 'phone:+14155550100' }),
    ])
    await e.update('forms', form.form_id, { name: 'Renamed' })
    await submit({ ...form, name: 'Renamed' }, [f('phone', '+14155550100')])
    expect(await e.rows('threads')).toEqual([expect.objectContaining({ subject: form.name })])
  })

  it('an invalid submitter is a validation_error and nothing is stored or written', async () => {
    const form = await seedForm()
    await expect(submit(form, [f('note', 'no address')])).rejects.toMatchObject({
      status: 400,
      code: 'validation_error',
    })
    expect(objects.writes).toEqual([])
    expect(await e.rows('events')).toEqual([])
  })
})

describe('the contact is added to, never changed (D14, P3)', () => {
  const seedContact = async (over: Record<string, unknown> = {}, address = 'jane@acme.test') => {
    const contact = await e.insert('contacts', { name: null, ...over })
    const identity = await e.insert('identities', { kind: 'email', value: address, contact_id: contact.id, own: false })
    return { contact, identity }
  }

  it('a known contact with a null name is filled, contact.updated once with before and after', async () => {
    const form = await seedForm()
    const { contact } = await seedContact()
    await submit(form, [f('email', 'jane@acme.test'), f('name', '  Jane Roe ')])
    expect((await e.rows('contacts')).find((r) => r.id === contact.id)).toMatchObject({ name: 'Jane Roe' })
    const updates = (await e.rows('events')).filter((r) => r.type === 'contact.updated')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ resource_id: contact.id, actor_id: form.form_id })
    expect(updates[0]!.before).toMatchObject({ name: null })
    expect(updates[0]!.after).toMatchObject({ name: 'Jane Roe' })
    expect(await e.rows('contacts')).toHaveLength(1)
  })

  it('a known contact with a name keeps it and gets no contact.updated', async () => {
    const form = await seedForm()
    const { contact } = await seedContact({ name: 'Existing' })
    await submit(form, [f('email', 'jane@acme.test'), f('name', 'Someone Else')])
    expect((await e.rows('contacts')).find((r) => r.id === contact.id)).toMatchObject({ name: 'Existing' })
    expect(await eventTypes()).not.toContain('contact.updated')
  })

  it('a null-name contact and a submission with no name: nothing to fill, no contact.updated', async () => {
    const form = await seedForm()
    await seedContact()
    await submit(form, [f('email', 'jane@acme.test')])
    expect(await eventTypes()).not.toContain('contact.updated')
  })

  it('a name written between plan and commit is not overwritten: the unit drifts and the retry sees it', async () => {
    const form = await seedForm()
    const { contact } = await seedContact()
    const probe = instrument()
    e.betweenPlanAndCommit(() => e.update('contacts', contact.id as string, { name: 'Written Meanwhile' }))
    await submit(form, [f('email', 'jane@acme.test'), f('name', 'Jane Roe')], {}, ctxOf({ binding: probe.binding }))
    expect(probe.executions()).toBe(2)
    expect((await e.rows('contacts')).find((r) => r.id === contact.id)).toMatchObject({ name: 'Written Meanwhile' })
    expect(await eventTypes()).not.toContain('contact.updated')
  })

  it("the form's live tags are linked (contact a, tag b), association.created each in tag id order, after contact.updated", async () => {
    const [t1, t2] = [await tag(), await tag()].sort()
    const form = await seedForm({ tag_ids: [t1!, t2!] })
    const { contact } = await seedContact()
    await submit(form, [f('email', 'jane@acme.test'), f('name', 'Jane')])
    const links = await e.rows('associations')
    expect(links.map((r) => [r.a_type, r.a_id, r.b_type, r.b_id, r.relation, r.created_by, r.deleted_at])).toEqual([
      ['contacts', contact.id, 'tags', t1, 'related_to', form.form_id, null],
      ['contacts', contact.id, 'tags', t2, 'related_to', form.form_id, null],
    ])
    expect(await eventTypes()).toEqual([
      'thread.created',
      'message.created',
      'interaction.created',
      'contact.updated',
      'association.created',
      'association.created',
    ])
    const created = (await e.rows('events')).filter((r) => r.type === 'association.created')
    expect(created.map((r) => r.resource_id)).toEqual(links.map((r) => r.id))
  })

  it("a linked tag is visible through the REST read: the contact list's tag_id filter finds it (the association types are table names, [[CHN432]] E2E finding)", async () => {
    const t1 = await tag()
    const other = await tag()
    const form = await seedForm({ tag_ids: [t1] })
    const { contact } = await seedContact()
    await submit(form, [f('email', 'jane@acme.test')])
    const app = createApp({ storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
    const token = mintTestUserToken({
      userId: form.form_id,
      organizationId: e.organizationId,
      scopes: ['contacts:read', 'tags:read', 'associations:read'],
    })
    const ids = async (tagId: string) =>
      (
        (await (
          await app.request(`/api/v1/contacts?tag_id=${tagId}`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as {
          data: Array<{ id: string }>
        }
      ).data.map((r) => r.id)
    expect(await ids(t1)).toEqual([contact.id])
    expect(await ids(other)).toEqual([])
  })

  it('an existing live link is left alone (no event); a soft-deleted one is linked afresh', async () => {
    const [t1, t2] = [await tag(), await tag()].sort()
    const form = await seedForm({ tag_ids: [t1!, t2!] })
    const { contact } = await seedContact({ name: 'Existing' })
    await e.insert('associations', {
      a_type: 'contacts',
      a_id: contact.id,
      b_type: 'tags',
      b_id: t1,
      relation: 'related_to',
    })
    await e.insert('associations', {
      a_type: 'contacts',
      a_id: contact.id,
      b_type: 'tags',
      b_id: t2,
      relation: 'related_to',
      deleted_at: SEED_AT,
    })
    await submit(form, [f('email', 'jane@acme.test')])
    const live = (await e.rows('associations')).filter((r) => r.deleted_at === null)
    expect(live.map((r) => r.b_id).sort()).toEqual([t1, t2])
    expect((await e.rows('events')).filter((r) => r.type === 'association.created')).toHaveLength(1)
  })

  it('a new contact gets every live tag of the form in the same unit', async () => {
    const t = await tag()
    const form = await seedForm({ tag_ids: [t] })
    await submit(form, [f('email', 'new@acme.test'), f('name', 'New')])
    const identity = (await e.rows('identities'))[0]!
    expect(await e.rows('associations')).toEqual([expect.objectContaining({ a_id: identity.contact_id, b_id: t })])
    expect(await eventTypes()).toEqual([
      'contact.created',
      'identity.created',
      'thread.created',
      'message.created',
      'interaction.created',
      'association.created',
    ])
  })

  it('an unattached identity is promoted: a contact named from the submission, identity.updated', async () => {
    const form = await seedForm()
    const identity = await e.insert('identities', {
      kind: 'email',
      value: 'jane@acme.test',
      contact_id: null,
      own: false,
    })
    await submit(form, [f('email', 'jane@acme.test'), f('name', 'Jane Roe')])
    const after = (await e.rows('identities')).find((r) => r.id === identity.id)!
    expect(after.contact_id).not.toBeNull()
    expect((await e.rows('contacts'))[0]).toMatchObject({ id: after.contact_id, name: 'Jane Roe' })
    expect(await eventTypes()).toEqual([
      'contact.created',
      'identity.updated',
      'thread.created',
      'message.created',
      'interaction.created',
    ])
  })

  it("a workspace member's own address: the interaction is captured inbound; no contact, no fill, no tag link", async () => {
    const t = await tag()
    const form = await seedForm({ tag_ids: [t] })
    await e.insert('identities', { kind: 'email', value: 'staff@acme.test', contact_id: null, own: true })
    await submit(form, [f('email', 'staff@acme.test'), f('name', 'Staff Person')])
    expect(await e.rows('interactions')).toEqual([expect.objectContaining({ channel: 'form', direction: 'inbound' })])
    expect(await e.rows('contacts')).toEqual([])
    expect(await e.rows('associations')).toEqual([])
    expect(await e.rows('identities')).toEqual([expect.objectContaining({ own: true, contact_id: null })])
    expect(await eventTypes()).toEqual(['thread.created', 'message.created', 'interaction.created'])
  })

  it('a stale form tag (deleted after the ingress read) is never linked: the unit refuses it and the submission is temporarily_unavailable', async () => {
    const t = await tag()
    const form = await seedForm({ tag_ids: [t] })
    await e.update('tags', t, { deleted_at: SEED_AT })
    await expect(submit(form, [f('email', 'jane@acme.test')])).rejects.toMatchObject({
      code: 'temporarily_unavailable',
    })
    expect(await e.rows('associations')).toEqual([])
    expect(await e.rows('messages')).toEqual([])
  })
})

describe('the workspace blocklist (D17, P2)', () => {
  const blocked = async (form: FormIngress, address: string) =>
    formSubmitterBlocked(ctxOf(), form, formSubmitter(form, [f('email', address)]))

  it('a blocked address and a blocked domain (and its subdomains) block; a lookalike does not', async () => {
    const form = await seedForm()
    await e.insert('blocked_senders', { kind: 'address', value: 'spam@bad.test' })
    await e.insert('blocked_senders', { kind: 'domain', value: 'evil.test' })
    expect(await blocked(form, 'Spam@Bad.test')).toBe(true)
    expect(await blocked(form, 'other@bad.test')).toBe(false)
    expect(await blocked(form, 'x@evil.test')).toBe(true)
    expect(await blocked(form, 'x@mail.evil.test')).toBe(true)
    expect(await blocked(form, 'x@notevil.test')).toBe(false)
    expect(await blocked(form, 'x@evil.test.example')).toBe(false)
  })

  it('the check writes nothing: no rows, no events, no stored objects', async () => {
    const form = await seedForm()
    await e.insert('blocked_senders', { kind: 'domain', value: 'evil.test' })
    expect(await blocked(form, 'x@evil.test')).toBe(true)
    for (const table of ['identities', 'contacts', 'threads', 'messages', 'interactions', 'events'])
      expect(await e.rows(table)).toEqual([])
    expect(objects.writes).toEqual([])
  })

  it('a deleted entry and a connection own entry do not block; with no entries at all the submission is captured', async () => {
    const form = await seedForm()
    expect(await blocked(form, 'x@evil.test')).toBe(false)
    await e.insert('blocked_senders', { kind: 'domain', value: 'evil.test', deleted_at: SEED_AT })
    expect(await blocked(form, 'x@evil.test')).toBe(false)
    const connectionId = uuidv7()
    await e.insert('identities', {
      id: connectionId,
      kind: 'email',
      value: 'conn@seed.test',
      contact_id: null,
      own: true,
      deleted_at: SEED_AT,
    })
    await e.insert('channel_connections', {
      id: connectionId,
      provider: 'google',
      account_id: 'acct',
      identity_id: connectionId,
      owner_id: e.userId,
      status: 'active',
      granted_scopes: [],
      connected_at: SEED_AT,
    })
    await e.insert('connection_blocked_senders', { connection_id: connectionId, kind: 'domain', value: 'evil.test' })
    await e.insert('connection_blocked_senders', { connection_id: connectionId, kind: 'address', value: 'x@evil.test' })
    expect(await blocked(form, 'x@evil.test')).toBe(false)
    expect((await submit(form, [f('email', 'x@evil.test')])).new_thread).toBe(true)
  })

  it('a phone submitter is never blocked', async () => {
    const form = await seedForm()
    await e.insert('blocked_senders', { kind: 'domain', value: 'evil.test' })
    expect(await formSubmitterBlocked(ctxOf(), form, { kind: 'phone', value: '+14155550100' })).toBe(false)
  })
})

describe('failure and retry (D18, P4, P5)', () => {
  it('one drift then success: one capture, the content stored once', async () => {
    const form = await seedForm()
    const probe = instrument({ drift: (k) => k === 1 })
    const out = await submit(form, [f('email', 'jane@acme.test')], {}, ctxOf({ binding: probe.binding }))
    expect(probe.executions()).toBe(2)
    expect(await e.rows('messages')).toHaveLength(1)
    expect(objects.writes).toHaveLength(2)
    expect(objects.deletes).toEqual([])
    expect(out.new_thread).toBe(true)
  })

  it('a unique-index failure of the unit (a racing writer) is retried like drift, once', async () => {
    const form = await seedForm()
    const probe = instrument({ unique: (k) => k === 1 })
    await submit(form, [f('email', 'jane@acme.test')], {}, ctxOf({ binding: probe.binding }))
    expect(probe.executions()).toBe(2)
    expect(await e.rows('messages')).toHaveLength(1)
    const twice = instrument({ unique: () => true })
    await expect(
      submit(form, [f('email', 'x@acme.test')], {}, ctxOf({ binding: twice.binding })),
    ).rejects.toMatchObject({ code: 'temporarily_unavailable' })
    expect(twice.executions()).toBe(2)
  })

  it('two drifts: temporarily_unavailable (two attempts, not three), the stored objects deleted, nothing written', async () => {
    const form = await seedForm()
    const probe = instrument({ drift: () => true })
    const err = await submit(form, [f('email', 'jane@acme.test')], {}, ctxOf({ binding: probe.binding })).catch(
      (x) => x,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 503, code: 'temporarily_unavailable' })
    expect(probe.executions()).toBe(2)
    expect([...objects.deletes].sort()).toEqual(objects.writes.map((w) => w.key).sort())
    expect(await objects.get(objects.writes[0]!.key)).toBeNull()
    for (const table of ['identities', 'contacts', 'threads', 'messages', 'interactions', 'events'])
      expect(await e.rows(table)).toEqual([])
  })

  it('a unit that fails (not drift): temporarily_unavailable, objects deleted; a failing delete does not mask the error', async () => {
    const form = await seedForm()
    // A constraint failure inside the unit: the form's agent row is gone, so created_by cannot reference it.
    const broken = { ...form, form_id: uuidv7() }
    const err = await submit(broken, [f('email', 'jane@acme.test')]).catch((x) => x)
    expect(err).toMatchObject({ status: 503, code: 'temporarily_unavailable' })
    expect(objects.deletes.length).toBe(2)
    objects.failDeletes(() => true)
    const again = await submit({ ...form, form_id: uuidv7() }, [f('email', 'jane@acme.test')]).catch((x) => x)
    expect(again).toMatchObject({ status: 503, code: 'temporarily_unavailable' })
    expect(await e.rows('messages')).toEqual([])
  })

  it('an object-store failure before the unit: temporarily_unavailable and no row', async () => {
    const form = await seedForm()
    objects.failWrites((key) => key.endsWith('original.json'))
    const err = await submit(form, [f('email', 'jane@acme.test')]).catch((x) => x)
    expect(err).toMatchObject({ status: 503, code: 'temporarily_unavailable' })
    expect(objects.deletes.length).toBe(2)
    expect(await e.rows('events')).toEqual([])
  })

  it('a commit of unknown outcome keeps the stored objects (the unit may have landed)', async () => {
    const form = await seedForm()
    const probe = instrument({ unknown: true })
    const err = await submit(form, [f('email', 'jane@acme.test')], {}, ctxOf({ binding: probe.binding })).catch(
      (x) => x,
    )
    expect(err).toMatchObject({ status: 503, code: 'temporarily_unavailable' })
    expect(objects.deletes).toEqual([])
    expect(objects.writes).toHaveLength(2)
  })

  it('two first submissions from one address racing: one thread, two messages, one contact', async () => {
    const form = await seedForm()
    const results = await Promise.allSettled([
      submit(form, [f('email', 'race@acme.test'), f('name', 'Racer')]),
      submit(form, [f('email', 'race@acme.test'), f('name', 'Racer')]),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(await e.rows('threads')).toHaveLength(1)
    expect(await e.rows('messages')).toHaveLength(2)
    expect(await e.rows('contacts')).toHaveLength(1)
    expect(await e.rows('identities')).toHaveLength(1)
  })
})
