import { describe, expect, it } from 'vitest'
import { Webhook } from 'standardwebhooks'
import { signatureHeader, WEBHOOK_HEADERS as VIBASE_HEADERS } from '@vibase/api'
import { TOLERANCE_SECONDS, WEBHOOK_HEADERS, verifyWebhook } from '../src/verify.js'
import { EVENT_ID, NOW_MS, OTHER_SECRET, SECRET, eventRecord, signedRequest } from './helpers.js'

const body = JSON.stringify(eventRecord())
const ts = Math.floor(NOW_MS / 1000)
const check = async (a: { secret?: string; headers: Record<string, string>; body?: string }) =>
  verifyWebhook({ secret: a.secret ?? SECRET, headers: new Headers(a.headers), body: a.body ?? body, nowMs: NOW_MS })
const goodHeaders = async (secrets = [SECRET]) => ({ 'webhook-id': EVENT_ID, 'webhook-timestamp': String(ts), 'webhook-signature': await signatureHeader({ secrets, id: EVENT_ID, timestamp: ts, body }) })

describe('verifyWebhook (D7, D21)', () => {
  it('reads the header names the vault sends', () => {
    expect(WEBHOOK_HEADERS).toEqual(VIBASE_HEADERS)
  })
  it('accepts a request signed by the vault\'s own signer', async () => {
    expect(await check({ headers: await goodHeaders() })).toEqual({ ok: true })
  })
  it('accepts a request signed by standardwebhooks@1.1.1 (the second oracle)', async () => {
    const wh = new Webhook(SECRET)
    const signature = wh.sign(EVENT_ID, new Date(ts * 1000), body)
    expect(await check({ headers: { 'webhook-id': EVENT_ID, 'webhook-timestamp': String(ts), 'webhook-signature': signature } })).toEqual({ ok: true })
  })
  it('refuses a tampered body', async () => {
    expect((await check({ headers: await goodHeaders(), body: body.replace('interaction', 'interactioN') })).ok).toBe(false)
  })
  it('refuses a wrong secret', async () => {
    expect((await check({ secret: OTHER_SECRET, headers: await goodHeaders() })).ok).toBe(false)
  })
  it('refuses a timestamp 6 minutes old or 6 minutes ahead, accepts 4 minutes either way', async () => {
    for (const [offset, ok] of [[-360, false], [360, false], [-240, true], [240, true]] as const) {
      const t = ts + offset
      const headers = { 'webhook-id': EVENT_ID, 'webhook-timestamp': String(t), 'webhook-signature': await signatureHeader({ secrets: [SECRET], id: EVENT_ID, timestamp: t, body }) }
      expect((await check({ headers })).ok, `offset ${offset}`).toBe(ok)
    }
    expect(TOLERANCE_SECONDS).toBe(300)
  })
  it('refuses each missing header', async () => {
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      const headers = { ...(await goodHeaders()) } as Record<string, string>
      delete headers[name]
      expect((await check({ headers })).ok, name).toBe(false)
    }
  })
  it('refuses a signature header with only unknown versions, and a timestamp that is not an integer', async () => {
    const good = await goodHeaders()
    expect((await check({ headers: { ...good, 'webhook-signature': good['webhook-signature'].replace('v1,', 'v2,') } })).ok).toBe(false)
    expect((await check({ headers: { ...good, 'webhook-timestamp': 'soon' } })).ok).toBe(false)
  })
  it('accepts a two-signature header (rotation overlap) with either secret configured', async () => {
    const headers = await goodHeaders([SECRET, OTHER_SECRET])
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2)
    expect(await check({ secret: SECRET, headers })).toEqual({ ok: true })
    expect(await check({ secret: OTHER_SECRET, headers })).toEqual({ ok: true })
  })
  it('skips an unknown version beside a good v1', async () => {
    const good = await goodHeaders()
    expect(await check({ headers: { ...good, 'webhook-signature': `v2,AAAA ${good['webhook-signature']}` } })).toEqual({ ok: true })
  })
})

describe('signedRequest helper', () => {
  it('produces a POST the verifier accepts', async () => {
    const req = await signedRequest()
    expect(await verifyWebhook({ secret: SECRET, headers: req.headers, body: await req.text(), nowMs: NOW_MS })).toEqual({ ok: true })
  })
})
