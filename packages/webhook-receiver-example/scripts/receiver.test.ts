import { describe, expect, it } from 'vitest'
import { handleWebhook, type ReceiverEnv } from '../src/receiver.js'
import { EVENT_ID, FakeWorkflow, NOW_MS, OTHER_SECRET, SECRET, eventRecord, signedRequest } from './helpers.js'

const setup = () => {
  const wf = new FakeWorkflow()
  const env: ReceiverEnv = { WEBHOOK_SECRET: SECRET, REPLY_WORKFLOW: wf }
  return { wf, env, call: async (req: Request) => handleWebhook(req, env, NOW_MS) }
}

describe('receiver: verification gates everything (D7, D21)', () => {
  it.each([
    ['a tampered body', async () => { const r = await signedRequest(); return new Request(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(eventRecord({ resource_id: '0192f4a0-0000-7000-8000-0000000000ff' })) }) }],
    ['a wrong secret', () => signedRequest({ secrets: [OTHER_SECRET] })],
    ['a stale timestamp', () => signedRequest({ timestamp: Math.floor(NOW_MS / 1000) - 360 })],
    ['a future timestamp', () => signedRequest({ timestamp: Math.floor(NOW_MS / 1000) + 360 })],
    ['a missing signature', () => signedRequest({ omit: ['webhook-signature'] })],
    ['a missing id', () => signedRequest({ omit: ['webhook-id'] })],
    ['only unknown versions', async () => { const r = await signedRequest(); const h = new Headers(r.headers); h.set('webhook-signature', h.get('webhook-signature')!.replace('v1,', 'v9,')); return new Request(r.url, { method: 'POST', headers: h, body: await r.text() }) }],
  ])('%s is 401 and creates nothing', async (_name, make) => {
    const { wf, call } = setup()
    const res = await call(await make())
    expect(res.status).toBe(401)
    expect(wf.creates).toEqual([])
  })
  it('accepts a two-signature header', async () => {
    const { wf, call } = setup()
    expect((await call(await signedRequest({ secrets: [OTHER_SECRET, SECRET] }))).status).toBe(200)
    expect(wf.creates).toHaveLength(1)
  })
  it('answers a non-POST 405 and a verified body that is not JSON 400, with no create', async () => {
    const { wf, call } = setup()
    expect((await call(await signedRequest({ method: 'GET' }))).status).toBe(405)
    expect((await call(await signedRequest({ body: 'not json' }))).status).toBe(400)
    expect((await call(await signedRequest({ body: '[1]' }))).status).toBe(400)
    expect(wf.creates).toEqual([])
  })
})

describe('receiver: start and acknowledge (D15, D21)', () => {
  it('a verified interaction.created creates one instance keyed by webhook-id, params = the body, and answers 2xx', async () => {
    const { wf, call } = setup()
    const res = await call(await signedRequest())
    expect(res.status).toBe(200)
    expect(wf.creates).toEqual([{ id: EVENT_ID, params: eventRecord() }])
  })
  it('a duplicate delivery whose create throws "already exists" is 2xx with no second instance', async () => {
    const { wf, call } = setup()
    expect((await call(await signedRequest())).status).toBe(200)
    expect((await call(await signedRequest())).status).toBe(200)
    expect(wf.instances.size).toBe(1)
  })
  it('an already-exists error is recognised by the message in each shape the platform may use', async () => {
    for (const message of ['instance.already_exists', 'Workflow instance already exists', 'InstanceAlreadyExists: already_exists']) {
      const { wf, call } = setup()
      wf.failWith = new Error(message)
      expect((await call(await signedRequest())).status, message).toBe(200)
    }
  })
  it('an unrecognised error is still success when the instance can be fetched by its id', async () => {
    const { wf, call } = setup()
    wf.instances.set(EVENT_ID, {})
    wf.failWith = new Error('something the platform changed the wording of')
    expect((await call(await signedRequest())).status).toBe(200)
  })
  it('any other create failure is 5xx so the vault retries', async () => {
    const { wf, call } = setup()
    wf.failWith = new Error('workflow engine unavailable')
    const res = await call(await signedRequest())
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.status).toBeLessThan(600)
  })
  it('another verified event type is 2xx with no instance', async () => {
    const { wf, call } = setup()
    const body = JSON.stringify(eventRecord({ type: 'task.created', resource_type: 'task' }))
    expect((await call(await signedRequest({ body }))).status).toBe(200)
    expect(wf.creates).toEqual([])
  })
})
