import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { operationOf } from '../identity/program.js'
import { memoryObjectStore } from '../objects/store.js'
import { recordMessages } from '../messaging/capture.js'
import { captureMessage, ensureConnection } from '../test/capture-kit.js'
import { openD1Engine, SEED_AT, type Engine } from '../test/engines.js'
import { nodeStreams } from '../test/streams.js'
import type { FormIngress } from '../forms/ingress-read.js'
import type { FormAnswer, FormSubmissionInput } from '../forms/map-submission.js'
import { captureFormSubmission, type FormSubmissionContext } from '../forms/submission.js'
import { createBuiltIns } from '../resources/built-ins.js'
import {
  GUARDED,
  applyGuarded,
  clearReferences,
  expectUntouched,
  guardViolations,
  rowsOf,
} from '../test/guarded-kit.js'

// [[CORE565]] obligations 2 and 6 (capture and the form submission): the two writers that create contacts outside the REST surface, on the guarded fixture, through the composed built-ins an `extend` gives (as production passes them).
const NOW = '2026-11-25T09:00:00.000Z'
const C1 = '0190b2c4-0000-7000-8000-0000000000c1'
const OWNER = 'owner@vibase.test'
const builtIns = createBuiltIns(GUARDED)
let e: Engine
beforeAll(async () => {
  e = await openD1Engine()
  await applyGuarded(e.d1!)
})
afterAll(() => e.close())
beforeEach(async () => {
  await clearReferences(e.d1!)
  await e.reset()
  await e.insert('identities', { kind: 'email', value: OWNER, contact_id: null, own: true })
})
const satisfied = async () => expect(await guardViolations(e.d1!)).toEqual([])
const contacts = () => rowsOf(e.d1!, 'contacts')
const first = async () => (await contacts())[0]!

const capture = async (...senders: string[]) => {
  await ensureConnection(e.binding, e, C1)
  const messages = senders.map((from) =>
    captureMessage(e.organizationId, {
      author: { user_id: from, user_name: from, full_name: from, is_bot: false },
      participants: [
        { kind: 'email', value: from, role: 'from' },
        { kind: 'email', value: OWNER, role: 'to' },
      ],
    }),
  )
  return e.run(
    operationOf(
      'capture.record',
      recordMessages(
        e.env(),
        { source: { kind: 'connection', id: C1 }, channel: 'email', messages },
        builtIns.contacts,
      ),
    ),
    'user',
  )
}

describe('capture', () => {
  it('a unit that creates three new contacts, then another that creates two more: every one at the defaults, no collision', async () => {
    await capture('a@guard.test', 'b@guard.test', 'c@guard.test')
    expect(await contacts()).toHaveLength(3)
    await capture('d@guard.test', 'e@guard.test')
    const rows = await contacts()
    expect(rows).toHaveLength(5)
    for (const r of rows) expectUntouched(r, 'contacts')
    await satisfied()
  })
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
    tag_ids: [],
    challenge: 'none',
  }
}
const f = (name: string, value: string): FormAnswer => ({ name, value })
const submit = (form: FormIngress, fields: FormAnswer[]) => {
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

describe('the form submission', () => {
  it('two submissions from two new addresses create two contacts at the defaults', async () => {
    const form = await seedForm()
    await submit(form, [f('email', 'jane@guard.test'), f('name', 'Jane')])
    await submit(form, [f('email', 'joe@guard.test'), f('name', 'Joe')])
    const rows = await contacts()
    expect(rows).toHaveLength(2)
    for (const r of rows) expectUntouched(r, 'contacts')
    await satisfied()
  })
  it('the name fill of a known contact leaves its extension columns as stored', async () => {
    const form = await seedForm()
    const known = await e.insert('contacts', { name: null })
    await e.insert('identities', { kind: 'email', value: 'jane@guard.test', contact_id: known.id, own: false })
    await e.d1!.prepare(`update contacts set code__c = 'KEPT', flag__c = 1 where id = ?`).bind(known.id).run()
    await submit(form, [f('email', 'jane@guard.test'), f('name', 'Jane Roe')])
    const r = await first()
    expect([r.name, r.code__c, r.flag__c, r.lvl__c]).toEqual(['Jane Roe', 'KEPT', 1, 'std'])
    await satisfied()
  })
})

describe('D21: a stale reference does not block the writers (565.4)', () => {
  /** A known contact whose `co__c` points at a soft-deleted company. */
  const staleContact = async (email: string, name: string | null) => {
    const company = await e.insert('companies', { name: 'Gone' })
    const known = await e.insert('contacts', { name })
    await e.insert('identities', { kind: 'email', value: email, contact_id: known.id, own: false })
    await e.d1!.prepare(`update contacts set co__c = ? where id = ?`).bind(company.id, known.id).run()
    await e.d1!.prepare(`update companies set deleted_at = ? where id = ?`).bind(SEED_AT, company.id).run()
    return { company: company.id as string, contact: known.id as string }
  }
  it('a capture from the holder succeeds and leaves the value as stored', async () => {
    const { company } = await staleContact('jane@acme.test', 'Jane')
    await capture('jane@acme.test', 'new@guard.test')
    expect((await contacts()).map((r) => r.co__c).sort()).toEqual([company, null])
    await satisfied()
  })
  it('a form fill of the holder succeeds and leaves the value as stored', async () => {
    const { company } = await staleContact('jane@guard.test', null)
    const form = await seedForm()
    await submit(form, [f('email', 'jane@guard.test'), f('name', 'Jane Roe')])
    const r = await first()
    expect([r.name, r.co__c]).toEqual(['Jane Roe', company])
    await satisfied()
  })
})
