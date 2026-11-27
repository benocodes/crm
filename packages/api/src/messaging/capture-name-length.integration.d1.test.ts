import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { openD1Engine, type Engine } from '../test/engines.js'
import { captureMessage, ensureConnection, runCapture } from '../test/capture-kit.js'
import { resolveOperation } from '../identity/resolve.js'
import { identityKit, type IdentityKit } from '../test/identity-kit.js'
import type { CaptureParticipant } from './capture.js'

// [[CORE683]] D12 (writers of `contacts.name`, 1 to 500 characters in the database from now on): the system writers that do not go through
// the API's create validation. Capture takes the contact name from a mail header and `resolveProgram` caps it (`cleanName`);
// the contact it writes must hold what the CHECK accepts, and a name the cap leaves empty must be NULL, never ''. D1 only.
const CONN = uuidv7()
const OWNER = 'owner@vibase.test'
let e: Engine
let k: IdentityKit
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  k = identityKit(e)
  await e.insert('identities', { kind: 'email', value: OWNER, contact_id: null, own: true })
  await ensureConnection(e.binding, e, CONN)
})

const from = (value: string, name?: string): CaptureParticipant => ({
  kind: 'email',
  value,
  role: 'from',
  ...(name === undefined ? {} : { name }),
})
const nameOf = async (value: string): Promise<string | null> => {
  const identity = (await e.rows('identities')).find((r) => r.value === value)!
  return ((await e.rows('contacts')).find((r) => r.id === identity.contact_id)!.name as string | null) ?? null
}
const chars = (s: string) => [...s].length

describe('the contact name a capture writes meets contacts_name_length', () => {
  it('a 600-character From name is capped at 500 and stored (no CHECK abort), through message capture', async () => {
    const r = await runCapture(e, {
      source: { kind: 'connection', id: CONN },
      channel: 'email',
      messages: [
        captureMessage(e.organizationId, {
          sent_by_connection: false,
          participants: [from('long@x.test', 'n'.repeat(600)), { kind: 'email', value: OWNER, role: 'to' }],
        }),
      ],
    })
    expect(r).toBeDefined()
    expect(await nameOf('long@x.test')).toBe('n'.repeat(500))
  })

  it('a name of astral characters is capped in code units, so its character count is within 500', async () => {
    await runCapture(e, {
      source: { kind: 'connection', id: CONN },
      channel: 'email',
      messages: [
        captureMessage(e.organizationId, {
          sent_by_connection: false,
          participants: [from('emoji@x.test', '😀'.repeat(400)), { kind: 'email', value: OWNER, role: 'to' }],
        }),
      ],
    })
    const stored = (await nameOf('emoji@x.test'))!
    expect(chars(stored)).toBeLessThanOrEqual(500)
    expect(chars(stored)).toBeGreaterThanOrEqual(1)
  })

  it('a blank name is stored as NULL, never as an empty string the CHECK would refuse', async () => {
    await runCapture(e, {
      source: { kind: 'connection', id: CONN },
      channel: 'email',
      messages: [
        captureMessage(e.organizationId, {
          sent_by_connection: false,
          participants: [from('blank@x.test', '   '), { kind: 'email', value: OWNER, role: 'to' }],
        }),
      ],
    })
    expect(await nameOf('blank@x.test')).toBeNull()
  })
})

describe('identities.resolve (the operation and the promotion path) meets the same limit', () => {
  const resolve = (entries: Parameters<typeof resolveOperation>[1]) => k.run((env) => resolveOperation(env, entries))

  it('a new contact from a long name is capped at 500; a promoted unattached identity gets the capped name too', async () => {
    const [made] = await resolve([{ kind: 'email', value: 'a@x.test', name: 'a'.repeat(900) }])
    expect(made!.contact!.name).toHaveLength(500)
    await e.insert('identities', { kind: 'email', value: 'u@x.test', contact_id: null, own: false })
    const [promoted] = await resolve([
      { kind: 'email', value: 'u@x.test', name: 'p'.repeat(900), mayCreateContact: true },
    ])
    expect(promoted!.contact!.name).toHaveLength(500)
    expect(await nameOf('u@x.test')).toBe('p'.repeat(500))
  })
})
