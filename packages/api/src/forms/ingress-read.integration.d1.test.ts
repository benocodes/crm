import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defineOperation, queryContext, unit } from '@vibase/storage'
import { openD1Engine, type Engine } from '../test/engines.js'
import { SEED_AT } from '../test/insert.js'
import { formIngressRead, type FormIngress } from './ingress-read.js'

// [[CHN424]] D14, P6: formIngressRead, composed into a prepared program's reads. Fixtures are direct inserts.
let e: Engine
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
})

let n = 0
const seedForm = async (over: Record<string, unknown> = {}, publicId?: string) => {
  n++
  const id = `0190b2c4-0000-7000-8000-0000000f${String(n).padStart(4, '0')}`
  await e.insert('principals', { id, kind: 'agent', created_at: SEED_AT })
  await e.insert('agents', { id, name: `Seed ${n}`, scopes: [], disabled_at: null })
  const pid = publicId ?? `frm_${String(n).padStart(26, '0').replace(/0/g, 'a')}`
  const row = await e.insert('forms', {
    id,
    name: `Seed ${n}`,
    public_id: pid,
    enabled: true,
    email_field: 'email',
    phone_field: null,
    name_field: 'name',
    consent_text: null,
    ...over,
  })
  return { id, publicId: pid, row }
}
const tag = async (over: Record<string, unknown> = {}) =>
  (await e.insert('tags', { name: `Tag ${++n}`, ...over })).id as string
const run = async (publicId: string): Promise<FormIngress | null> =>
  (
    await e.run(
      defineOperation<FormIngress | null>({
        name: 'test.form_ingress_read',
        mutates: false,
        reads: (qc) => ({ form: formIngressRead(qc, publicId).read }),
        build: (found, qc) =>
          unit({ steps: [], events: [], decode: () => formIngressRead(qc, publicId).decode(found.maybe('form')) }),
      }),
    )
  ).value

describe('formIngressRead (D14)', () => {
  it('the exact shape for a form with origins and tags, tag_ids and origins sorted', async () => {
    const f = await seedForm({ phone_field: 'phone', consent_text: 'We store it.' })
    await e.insert('form_allowed_origins', { form_id: f.id, origin: 'https://b.example' })
    await e.insert('form_allowed_origins', { form_id: f.id, origin: 'https://a.example' })
    const [t1, t2] = [await tag(), await tag()]
    for (const t of [t2, t1]) await e.insert('form_tags', { form_id: f.id, tag_id: t })
    expect(await run(f.publicId)).toEqual({
      form_id: f.id,
      organization_id: e.organizationId,
      name: 'Seed 1',
      enabled: true,
      allowed_origins: ['https://a.example', 'https://b.example'],
      email_field: 'email',
      phone_field: 'phone',
      name_field: 'name',
      challenge: 'turnstile',
      consent_text: 'We store it.',
      tag_ids: [t1, t2].sort(),
    })
  })

  it('tag_ids lists live tags only: a soft-deleted tag is absent', async () => {
    const f = await seedForm()
    const [t1, t2] = [await tag(), await tag({ deleted_at: SEED_AT })]
    for (const t of [t1, t2]) await e.insert('form_tags', { form_id: f.id, tag_id: t })
    expect((await run(f.publicId))!.tag_ids).toEqual([t1])
  })

  it('empty state: a form with neither origins nor tags reads empty lists', async () => {
    const f = await seedForm({ email_field: null, phone_field: 'p', name_field: null })
    expect(await run(f.publicId)).toMatchObject({
      allowed_origins: [],
      tag_ids: [],
      email_field: null,
      phone_field: 'p',
    })
  })

  it('a disabled form is returned with enabled: false', async () => {
    const f = await seedForm({ enabled: false })
    expect((await run(f.publicId))!.enabled).toBe(false)
  })

  it('is null for an unknown public id and for a soft-deleted form', async () => {
    const live = await seedForm()
    const gone = await seedForm({ deleted_at: SEED_AT })
    expect(await run(`frm_${'z'.repeat(26)}`)).toBeNull()
    expect(await run(gone.publicId)).toBeNull()
    expect(await run(live.publicId)).not.toBeNull()
  })

  it('the result survives structuredClone and JSON unchanged (invariant 7)', async () => {
    const f = await seedForm()
    await e.insert('form_allowed_origins', { form_id: f.id, origin: 'https://a.example' })
    const r = (await run(f.publicId))!
    expect(structuredClone(r)).toEqual(r)
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })

  it('a dialect other than D1 throws', () => {
    const qc = queryContext('postgres' as never)
    expect(() => formIngressRead(qc, 'frm_x')).toThrow(/D1 only/)
  })
})
