import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { stripInvisibleCharacters } from '../channels/invisible-characters.js'
import { memoryObjectStore } from '../objects/store.js'
import { openD1Engine, SEED_AT, type Engine } from '../test/engines.js'
import { recordingObjectStore, type RecordingStore } from '../test/objects.js'
import { nodeStreams } from '../test/streams.js'
import type { FormIngress } from './ingress-read.js'
import { type FormAnswer, type FormSubmissionInput } from './map-submission.js'
import { captureFormSubmission, type FormSubmissionContext } from './submission.js'

// [[CHN193]] D4 ([[AGT588]]): a form submission's stored text and names are stripped like a mail's. D1 only.
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
const bodyOf = async (contentKey: string) =>
  new TextDecoder().decode(
    new Uint8Array(await new Response((await objects.get(`${contentKey}/v1/body.md`))!.body).arrayBuffer()),
  )

const HIDE = `\u200B\u202E${String.fromCodePoint(0xe0041)}`
/** Whether the text holds a character the rule strips (exact results are pinned in `invisible-characters.test.ts`). */
const INVISIBLE = { test: (text: string): boolean => stripInvisibleCharacters(text) !== text }

describe('invisible characters in a form submission', () => {
  it('the stored body, the preview and the contact name are clean', async () => {
    const form = await seedForm()
    const out = await submit(form, [
      f('email', 'jane@acme.test'),
      f('name', `Jane${HIDE} Roe`),
      f('note', `Pay${HIDE} now`),
    ])
    const msg = (await e.rows('messages'))[0]!
    expect(await bodyOf(String(msg.content_key))).toContain('Pay now')
    expect(await bodyOf(String(msg.content_key))).not.toSatisfy((text: string) => INVISIBLE.test(text))
    expect(String(msg.preview)).not.toSatisfy((text: string) => INVISIBLE.test(text))
    expect(String(msg.preview)).toContain('Pay now')
    expect((await e.rows('contacts')).map((c) => c.name)).toEqual(['Jane Roe'])
    expect(out).toBeDefined()
  })
  it('the interaction participants and the author carry the clean name', async () => {
    const form = await seedForm({ name: `Web${HIDE}site` })
    await submit(form, [f('email', 'jane@acme.test'), f('name', `Jane${HIDE}`)])
    const threads = await e.rows('threads')
    for (const t of threads) expect(String(t.subject ?? '')).not.toSatisfy((text: string) => INVISIBLE.test(text))
    expect(threads.map((t) => t.subject)).toEqual(['Website'])
    expect((await e.rows('contacts')).map((c) => c.name)).toEqual(['Jane'])
  })
  it('a later submission that names a so-far unnamed contact fills the clean name', async () => {
    const form = await seedForm()
    await submit(form, [f('email', 'jane@acme.test')])
    expect((await e.rows('contacts')).map((c) => c.name)).toEqual([null])
    await submit(form, [f('email', 'jane@acme.test'), f('name', `Jane${HIDE} Roe`)])
    expect((await e.rows('contacts')).map((c) => c.name)).toEqual(['Jane Roe'])
  })
  it('the stored author is clean', async () => {
    const form = await seedForm()
    await submit(form, [f('email', 'jane@acme.test'), f('name', `Jane${HIDE} Roe`)])
    const author = (await e.rows('messages'))[0]!.author as Record<string, string>
    expect(author.full_name).toBe('Jane Roe')
    expect(author.user_name).toBe('Jane Roe')
  })
})
