import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createApp } from '../rest/app.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { captureMessage, ensureConnection, runCapture, type CaptureOverrides } from '../test/capture-kit.js'
import type { CaptureMessage, CaptureSource } from './capture.js'

// [[CHN421]] cycle 1, groups 3 to 6, D1 only (the form source is D1 only): `recordMessages` captures a chunk from a form on
// channel 'form' through the capture kit, never crossing the connection kind (P1, 421.27), with the direction override (D11).
const CONN = uuidv7()
const FORM_A = uuidv7()
const FORM_B = uuidv7()
const OWNER = 'owner@vibase.test'

let e: Engine
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})

/** A form needs its principal, agent and forms rows (the form's principal shares its id, CHN420 D3): a test device, not an operation. */
async function ensureForm(formId: string, n: number) {
  await e.insert('principals', { id: formId, kind: 'agent', created_at: '2026-10-22T08:00:00.000Z' })
  await e.insert('agents', { id: formId, name: `form agent ${n}`, scopes: [] })
  await e.insert('forms', {
    id: formId,
    name: `Website ${n}`,
    public_id: `frm_${String(n).repeat(26)}`,
    enabled: true,
    email_field: 'email',
    phone_field: null,
    name_field: null,
    consent_text: null,
  })
}
beforeEach(async () => {
  await e.reset()
  await e.insert('identities', { kind: 'email', value: OWNER, contact_id: null, own: true })
  await ensureConnection(e.binding, e, CONN)
  await ensureForm(FORM_A, 1)
  await ensureForm(FORM_B, 2)
})

const formSource = (id = FORM_A): CaptureSource => ({ kind: 'form', id })
const connSource: CaptureSource = { kind: 'connection', id: CONN }
const formMsg = (over: CaptureOverrides = {}): CaptureMessage =>
  captureMessage(e.organizationId, {
    channel: 'form',
    direction: 'inbound',
    participants: [{ kind: 'email', value: 'lead@site.test', role: 'from' }],
    ...over,
  })
const capForm = (messages: CaptureMessage[], id = FORM_A) =>
  runCapture(e, { source: formSource(id), channel: 'form', messages })
const capMail = (messages: CaptureMessage[]) => runCapture(e, { source: connSource, channel: 'email', messages })
const types = async () => (await e.rows('events')).map((r) => String(r.type))

describe('a form source on channel form (group 3)', () => {
  it('writes thread, message, interaction, participant and sources with form_id and a null connection_id', async () => {
    const m = formMsg({ provider_message_id: 'sub-1', provider_thread_id: 'email:lead@site.test' })
    const { value } = await capForm([m])
    expect(value.captured).toHaveLength(1)
    expect(await e.rows('threads')).toEqual([expect.objectContaining({ channel: 'form' })])
    expect(await e.rows('messages')).toEqual([expect.objectContaining({ channel: 'form', external_id: m.external_id })])
    expect(await e.rows('interactions')).toEqual([expect.objectContaining({ channel: 'form', direction: 'inbound' })])
    expect(await e.rows('interaction_participants')).toHaveLength(1)
    expect(await e.rows('message_sources')).toEqual([
      expect.objectContaining({ form_id: FORM_A, connection_id: null, provider_message_id: 'sub-1' }),
    ])
    expect(await e.rows('thread_sources')).toEqual([
      expect.objectContaining({ form_id: FORM_A, connection_id: null, provider_thread_id: 'email:lead@site.test' }),
    ])
  })

  it('emits the same events as an email capture of the same shape', async () => {
    await capForm([formMsg()])
    const form = await types()
    await e.reset()
    await e.insert('identities', { kind: 'email', value: OWNER, contact_id: null, own: true })
    await ensureConnection(e.binding, e, CONN)
    await capMail([
      captureMessage(e.organizationId, { participants: [{ kind: 'email', value: 'lead@site.test', role: 'from' }] }),
    ])
    expect(form.sort()).toEqual((await types()).sort())
    expect(form).toContain('interaction.created')
  })

  it('replaying the chunk writes nothing new; a second message with the same provider thread joins the thread', async () => {
    const m1 = formMsg({ provider_message_id: 'sub-1', provider_thread_id: 'email:a@site.test' })
    const first = await capForm([m1])
    const before = { events: await types(), messages: (await e.rows('messages')).length }
    const replay = await capForm([m1])
    expect(replay.value.captured).toEqual([])
    expect(replay.value.existing).toHaveLength(1)
    expect({ events: await types(), messages: (await e.rows('messages')).length }).toEqual(before)

    const m2 = formMsg({ provider_message_id: 'sub-2', provider_thread_id: 'email:a@site.test' })
    const second = await capForm([m2])
    expect(second.value.captured[0]!.thread_id).toBe(first.value.captured[0]!.thread_id)
    expect(second.value.captured[0]!.new_thread).toBe(false)
    expect(await e.rows('threads')).toHaveLength(1)
    expect(await e.rows('message_sources')).toHaveLength(2)
  })

  it("a message whose channel differs from its chunk's is a programmer error, before anything is written", async () => {
    const wrong = captureMessage(e.organizationId, {})
    await expect(capForm([wrong])).rejects.toThrow(/channel must equal its chunk's channel/)
    await expect(capMail([formMsg()])).rejects.toThrow(/channel must equal its chunk's channel/)
    expect(await e.rows('messages')).toEqual([])
  })
})

describe('the two source kinds never cross (group 4, P1)', () => {
  it('a connection and a form with equal provider and external ids make two messages in two threads', async () => {
    const shared = { external_id: 'same@x', provider_message_id: 'same-pm', provider_thread_id: 'same-pt' }
    await capMail([captureMessage(e.organizationId, shared)])
    await capForm([formMsg(shared)])
    await capForm([formMsg({ ...shared, external_id: 'other@x' })], FORM_B)
    const threads = await e.rows('threads')
    expect(threads.map((t) => t.channel).sort()).toEqual(['email', 'form', 'form'])
    expect(await e.rows('messages')).toHaveLength(3)
    const sources = await e.rows('message_sources')
    expect(sources.map((s) => [s.connection_id, s.form_id]).sort()).toEqual(
      [
        [CONN, null],
        [null, FORM_A],
        [null, FORM_B],
      ].sort(),
    )
    expect(new Set((await e.rows('thread_sources')).map((s) => s.thread_id)).size).toBe(3)
  })
})

describe('direction (group 5, D11)', () => {
  it('a message from an own address is inbound with the override and without it: an own from no longer makes it outbound (CORE574 D5)', async () => {
    const own = [{ kind: 'email' as const, value: OWNER, role: 'from' as const }]
    await capForm([formMsg({ participants: own, provider_thread_id: 'email:o1' })])
    expect(await e.rows('interactions')).toEqual([expect.objectContaining({ direction: 'inbound', channel: 'form' })])
    await capForm([formMsg({ participants: own, provider_thread_id: 'email:o2', direction: undefined })])
    expect((await e.rows('interactions')).map((r) => r.direction).sort()).toEqual(['inbound', 'inbound'])
  })
})

describe('the widened surfaces (group 6)', () => {
  it('channel=form on the three list filters returns only form rows; channel=email returns only email rows', async () => {
    await capMail([captureMessage(e.organizationId, {})])
    await capForm([formMsg()])
    const app = createApp({ storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
    const token = mintTestUserToken({
      userId: e.userId,
      organizationId: e.organizationId,
      scopes: ['threads:read', 'messages:read', 'interactions:read'],
      kind: 'user',
    })
    for (const resource of ['threads', 'messages', 'interactions']) {
      for (const channel of ['form', 'email']) {
        const res = await app.request(`https://vibase.test/api/v1/${resource}?channel=${channel}`, {
          headers: { authorization: `Bearer ${token}` },
        })
        expect(res.status, await res.clone().text()).toBe(200)
        const body = (await res.json()) as { data: Array<{ channel: string }> }
        expect(body.data.length, `${resource} ${channel}`).toBe(1)
        expect(body.data.every((r) => r.channel === channel)).toBe(true)
      }
    }
  })
})
