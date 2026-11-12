import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Webhook, WebhookVerificationError } from 'standardwebhooks'
import { ROTATION_OVERLAP_MS } from './secrets.js'
import { secretsInForce, signatureHeader } from './signing.js'

// API7 / API220 (D7, D12): the signature is Standard Webhooks' v1, verified here by the `standardwebhooks@1.1.1` library as the oracle (a dev dependency; the vault signs with Web Crypto and imports no
// library). `Webhook#verify` judges the timestamp against the REAL clock, so the timestamps below are built from `Date.now()`.
const KEY = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
const S1 = 'whsec_' + Buffer.from(KEY).toString('base64')
const S2 = 'whsec_' + Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 1)).toString('base64')
const BODY = JSON.stringify({ id: 'evt', type: 'task.created', after: { title: 'a "quoted" é task' } })
const nowSec = () => Math.floor(Date.now() / 1000)
const headers = (signature: string, id = 'msg_1', timestamp = nowSec()) => ({ 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature })

describe('signatureHeader (D7)', () => {
  it('is v1, base64 HMAC-SHA256 of "<id>.<timestamp>.<body>" under the decoded key (an independent computation), and the library verifies it', async () => {
    const ts = nowSec()
    const header = await signatureHeader({ secrets: [S1], id: 'msg_1', timestamp: ts, body: BODY })
    const expected = createHmac('sha256', Buffer.from(KEY)).update(`msg_1.${ts}.${BODY}`).digest('base64')
    expect(header).toBe(`v1,${expected}`)
    expect(new Webhook(S1).verify(BODY, headers(header, 'msg_1', ts))).toEqual(JSON.parse(BODY))
  })

  it('a tampered body, another id and another secret are rejected', async () => {
    const ts = nowSec()
    const header = await signatureHeader({ secrets: [S1], id: 'msg_1', timestamp: ts, body: BODY })
    expect(() => new Webhook(S1).verify(BODY + ' ', headers(header, 'msg_1', ts))).toThrow(WebhookVerificationError)
    expect(() => new Webhook(S1).verify(BODY, headers(header, 'msg_2', ts))).toThrow(WebhookVerificationError)
    expect(() => new Webhook(S2).verify(BODY, headers(header, 'msg_1', ts))).toThrow(WebhookVerificationError)
  })

  it('a timestamp six minutes old is rejected by the receiver tolerance, one a minute old is accepted', async () => {
    const old = nowSec() - 6 * 60
    const stale = await signatureHeader({ secrets: [S1], id: 'msg_1', timestamp: old, body: BODY })
    expect(() => new Webhook(S1).verify(BODY, headers(stale, 'msg_1', old))).toThrow(/too old/)
    const recent = nowSec() - 60
    const fresh = await signatureHeader({ secrets: [S1], id: 'msg_1', timestamp: recent, body: BODY })
    expect(() => new Webhook(S1).verify(BODY, headers(fresh, 'msg_1', recent))).not.toThrow()
  })

  it('one secret gives one signature; two give two, space separated, each verifying alone', async () => {
    const ts = nowSec()
    const one = await signatureHeader({ secrets: [S2], id: 'msg_1', timestamp: ts, body: BODY })
    expect(one.split(' ')).toHaveLength(1)
    const both = await signatureHeader({ secrets: [S2, S1], id: 'msg_1', timestamp: ts, body: BODY })
    const parts = both.split(' ')
    expect(parts).toHaveLength(2)
    expect(parts.every((p) => /^v1,[A-Za-z0-9+/]{43}=$/.test(p))).toBe(true)
    expect(parts[0]).toBe(one)
    for (const [secret, part] of [[S2, parts[0]!], [S1, parts[1]!]] as const) expect(new Webhook(secret).verify(BODY, headers(part, 'msg_1', ts))).toEqual(JSON.parse(BODY))
    expect(new Webhook(S1).verify(BODY, headers(both, 'msg_1', ts))).toEqual(JSON.parse(BODY))
    expect(new Webhook(S2).verify(BODY, headers(both, 'msg_1', ts))).toEqual(JSON.parse(BODY))
  })
})

describe('secretsInForce (D12)', () => {
  const at = (ms: number) => new Date(Date.parse('2026-11-12T10:00:00.000Z') + ms).toISOString()
  const NOW = new Date('2026-11-12T10:00:00.000Z')
  const rows = (...ages: number[]) => ages.map((age, i) => ({ created_at: new Date(NOW.getTime() - age).toISOString(), n: i }))

  it('a single secret is the only one, however old', () => {
    expect(secretsInForce(rows(400 * 86_400_000), NOW).map((r) => r.n)).toEqual([0])
  })

  it('while the newest is under 24 hours old, it and the one before it, newest first', () => {
    // rows are oldest first (as read): ages 3 days, 2 days, 1 hour
    expect(secretsInForce(rows(3 * 86_400_000, 2 * 86_400_000, 3_600_000), NOW).map((r) => r.n)).toEqual([2, 1])
  })

  it('at exactly 24 hours and past it, only the newest', () => {
    expect(secretsInForce(rows(2 * 86_400_000, ROTATION_OVERLAP_MS - 1), NOW).map((r) => r.n)).toEqual([1, 0])
    expect(secretsInForce(rows(2 * 86_400_000, ROTATION_OVERLAP_MS), NOW).map((r) => r.n)).toEqual([1])
    expect(secretsInForce(rows(2 * 86_400_000, ROTATION_OVERLAP_MS + 1), NOW).map((r) => r.n)).toEqual([1])
    expect(at(0)).toBe(NOW.toISOString())
  })

  it('no secret is none', () => {
    expect(secretsInForce([], NOW)).toEqual([])
  })
})
