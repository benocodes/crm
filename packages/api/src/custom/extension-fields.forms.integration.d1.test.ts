import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { memoryObjectStore } from '../objects/store.js'
import { openD1Engine, SEED_AT, type Engine } from '../test/engines.js'
import { nodeStreams } from '../test/streams.js'
import type { FormIngress } from '../forms/ingress-read.js'
import type { FormAnswer, FormSubmissionInput } from '../forms/map-submission.js'
import { captureFormSubmission, type FormSubmissionContext } from '../forms/submission.js'
import { createBuiltIns } from '../resources/built-ins.js'
import { applyExtend } from '../test/extension-kit.js'

// [[CORE559]] P2, P7: a form submission (its resolve creating a contact, and the name fill of an existing one) emits events that carry the contact's extension fields, from the composed definition the context holds.
const NOW = '2026-11-18T09:00:00.000Z'
const EXTEND = {
  contacts: {
    note__c: { kind: 'text' },
    lvl__c: { kind: 'enum', values: ['a', 'b'], required: true, default: 'a' },
  },
} as const
let e: Engine
beforeAll(async () => {
  e = await openD1Engine()
  await applyExtend(e.d1!, EXTEND as never)
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
})

let n = 0
async function seedForm(): Promise<FormIngress> {
  n++
  const id = `0190b2c4-0000-7000-8000-0000000f${String(n).padStart(4, '0')}`
  await e.insert('principals', { id, kind: 'agent', created_at: SEED_AT })
  await e.insert('agents', { id, name: `Form agent ${n}`, scopes: [] })
  await e.insert('forms', {
    id,
    name: `Website ${n}`,
    public_id: `frm_${String(n).padStart(26, 'a')}`,
    enabled: true,
    email_field: 'email',
    phone_field: 'phone',
    name_field: 'name',
    consent_text: null,
  })
  return {
    form_id: id,
    organization_id: e.organizationId,
    name: `Website ${n}`,
    enabled: true,
    allowed_origins: ['https://site.test'],
    email_field: 'email',
    phone_field: 'phone',
    name_field: 'name',
    consent_text: null,
    challenge: 'turnstile',
    tag_ids: [],
  }
}
const f = (name: string, value: string): FormAnswer => ({ name, value })
const submit = (form: FormIngress, fields: FormAnswer[], builtIns = createBuiltIns(EXTEND as never)) => {
  const ctx: FormSubmissionContext = {
    binding: e.binding,
    organizationId: e.organizationId,
    objects: memoryObjectStore(),
    streams: nodeStreams(),
    clock: () => new Date(NOW),
    newId: () => uuidv7(new Date(NOW)),
    randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
    builtIns,
  }
  const input: FormSubmissionInput = {
    form,
    public_id: 'frm_x',
    fields,
    consent_given: false,
    anonymous_id: null,
    origin: 'https://site.test',
    content_type: 'application/json',
    received_at: NOW,
    submission_id: uuidv7(new Date(NOW)),
  }
  return captureFormSubmission(ctx, input)
}
const events = async (type: string) => (await e.rows('events')).filter((r) => r.type === type)

describe('a form submission carries the contact extension fields in its events', () => {
  it('a new address: contact.created holds the stored default of the extension column', async () => {
    const form = await seedForm()
    await submit(form, [f('email', 'jane@acme.test'), f('name', 'Jane')])
    const [created] = await events('contact.created')
    expect(created!.after).toMatchObject({ name: 'Jane', note__c: null, lvl__c: 'a' })
  })

  it('a known contact with a null name is filled: contact.updated carries the fields before and after, and the fill writes no extension column', async () => {
    const form = await seedForm()
    const contact = await e.insert('contacts', { name: null })
    await e.insert('identities', { kind: 'email', value: 'jane@acme.test', contact_id: contact.id, own: false })
    await e.d1!.prepare(`update contacts set note__c = 'kept' where id = ?`).bind(contact.id).run()
    await submit(form, [f('email', 'jane@acme.test'), f('name', 'Jane Roe')])
    const [updated] = await events('contact.updated')
    expect(updated!.before).toMatchObject({ name: null, note__c: 'kept', lvl__c: 'a' })
    expect(updated!.after).toMatchObject({ name: 'Jane Roe', note__c: 'kept', lvl__c: 'a' })
  })
})
