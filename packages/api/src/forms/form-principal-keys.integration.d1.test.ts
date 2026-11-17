import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openApiKeyKit, NO_SUCH, type ApiKeyKit } from '../test/api-key-kit.js'
import { SEED_AT } from '../test/insert.js'

// [[CHN423]] group 2: api_keys.create refuses a form's principal, decided from the CRM agent read before any control write.
let k: ApiKeyKit
beforeAll(async () => {
  k = await openApiKeyKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const KEYS = '/meta/v1/api-keys'
let seeded = 0
const seedForm = async (deleted: boolean) => {
  seeded++
  const id = `0190b2c4-0000-7000-8000-0000000d${String(seeded).padStart(4, '0')}`
  await k.e.insert('principals', { id, kind: 'agent', created_at: SEED_AT })
  await k.e.insert('agents', { id, name: `Form ${seeded}`, scopes: [], disabled_at: deleted ? SEED_AT : null })
  await k.e.insert('forms', {
    id,
    name: `Form ${seeded}`,
    public_id: `frm_${String(seeded).padStart(26, '0').replace(/0/g, 'a')}`,
    enabled: true,
    email_field: 'email',
    phone_field: null,
    name_field: 'name',
    consent_text: null,
    ...(deleted ? { deleted_at: SEED_AT } : {}),
  })
  return id
}

describe('api_keys.create and form principals', () => {
  for (const deleted of [false, true])
    it(`${deleted ? 'a deleted' : 'a live'} form's agent: 409 form_principal, no api_keys row, no control_audit row`, async () => {
      const id = await seedForm(deleted)
      const before = await k.counts()
      const r = await k.owner('POST', KEYS, { agent_id: id })
      expect([r.status, r.body.error.code]).toEqual([409, 'form_principal'])
      expect(r.body.error.message).toBe(`managed by form ${id}; change the form`)
      expect(await k.counts()).toEqual(before)
      expect(await k.ctl('select * from api_keys')).toEqual([])
    })

  it('the error order: a bad expires_at is 400 and an unknown agent 400 invalid_reference, both before the form check', async () => {
    const id = await seedForm(false)
    const past = await k.owner('POST', KEYS, { agent_id: id, expires_at: '2020-01-01T00:00:00.000Z' })
    expect([past.status, past.body.error.code]).toEqual([400, 'validation_error'])
    const bad = await k.owner('POST', KEYS, { agent_id: 'nope' })
    expect(bad.status).toBe(400)
    const unknown = await k.owner('POST', KEYS, { agent_id: NO_SUCH })
    expect([unknown.status, unknown.body.error.code]).toEqual([400, 'invalid_reference'])
  })

  it('an ordinary agent, including a disabled one, is still issued a key', async () => {
    expect((await k.owner('POST', KEYS, { agent_id: k.e.agentId })).status).toBe(201)
    const other = await k.seedAgent()
    await k.e.update('agents', other, { disabled_at: SEED_AT })
    expect((await k.owner('POST', KEYS, { agent_id: other })).status).toBe(201)
  })
})
