import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { memoryObjectStore } from '../objects/store.js'
import { openD1Engine, SEED_AT, type Engine } from '../test/engines.js'
import { recordingObjectStore, type RecordingStore } from '../test/objects.js'
import { nodeStreams } from '../test/streams.js'
import type { FormIngress } from './ingress-read.js'
import type { FormAnswer, FormSubmissionInput } from './map-submission.js'
import { captureFormSubmission, type FormSubmissionContext } from './submission.js'

// [[CORE683]] D12: the form submission's contact name meets `contacts_name_length` (1 to 500 characters in the database). The name comes from the
// form's `name_field`, capped by `cleanName` and stripped of invisible characters; a first submission writes it through the capture program, a repeat fills a
// nameless contact through the submission's own UPDATE. D1 only.
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
    challenge: 'turnstile',
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

const nameOf = async (value: string) => {
  const identity = (await e.rows('identities')).find((r) => r.value === value)!
  return (await e.rows('contacts')).find((r) => r.id === identity.contact_id)!.name as string | null
}

describe('the contact name a form submission writes meets contacts_name_length', () => {
  it('a first submission with a 700-character name stores it capped at 500', async () => {
    const form = await seedForm()
    await submit(form, [f('email', 'long@acme.test'), f('name', 'n'.repeat(700))])
    expect(await nameOf('long@acme.test')).toBe('n'.repeat(500))
  })

  it('a repeat submission that fills a nameless contact (the UPDATE) writes the capped name', async () => {
    const form = await seedForm()
    await submit(form, [f('email', 'fill@acme.test')])
    expect(await nameOf('fill@acme.test')).toBeNull()
    await submit(form, [f('email', 'fill@acme.test'), f('name', 'f'.repeat(700))], { submission_id: uuidv7(new Date(NOW)) })
    expect(await nameOf('fill@acme.test')).toBe('f'.repeat(500))
  })

  it('a name of only invisible characters is no name: NULL, not an empty string', async () => {
    const form = await seedForm()
    await submit(form, [f('email', 'ghost@acme.test'), f('name', '\u200b\u200b')])
    expect(await nameOf('ghost@acme.test')).toBeNull()
  })
})
