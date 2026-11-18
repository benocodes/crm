import { fileURLToPath } from 'node:url'
import { BASE, PAIRED_ORG, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { MIGRATIONS } from '@vibase/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { seedAgent } from '@vibase/storage-d1/test/seed'
import { unstable_readConfig } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// [[CHN432]] D1, P1, P2, D7, P4 (432.2, 432.3, 432.6): `/f/*` in the REAL Worker module, in workerd (Miniflare), with the `ratelimits` bindings read from the REAL wrangler.jsonc.
const ENTRY = fileURLToPath(new URL('./worker.ts', import.meta.url))
const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const ORIGIN = 'https://example.com'
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'
const TEST_SECRET = '1x0000000000000000000000000000000AA'
const SEEDED_AT = '2026-11-18T09:00:00.000Z'

const config = unstable_readConfig({ config: CONFIG })
const ratelimits = Object.fromEntries(
  (config.ratelimits ?? []).map((r) => [r.name, { namespace_id: r.namespace_id, simple: r.simple }]),
)

let bundle: Bundle
const open: Workerd[] = []
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
}, 120_000)
afterAll(async () => {
  await Promise.all(open.map((w) => w.dispose()))
  bundle?.dispose()
})

interface Started {
  w: Workerd
  siteverify: URLSearchParams[]
}
async function start(
  o: { paired?: boolean; behind?: boolean; limits?: boolean; secret?: string | null } = {},
): Promise<Started> {
  const siteverify: URLSearchParams[] = []
  const w = await startWorkerd({
    bundle,
    paired: o.paired ?? true,
    bindings: {
      AUTH_PROVIDER: '',
      ...(o.secret === null ? {} : { TURNSTILE_SECRET_KEY: o.secret ?? TEST_SECRET }),
    },
    outbound: async (req) => {
      if (req.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
        throw new Error(`unexpected outbound request ${req.url}`)
      const sent = new URLSearchParams(await req.text())
      siteverify.push(sent)
      return Response.json(
        sent.get('response') === DUMMY_TOKEN
          ? { success: true, hostname: 'example.com' }
          : { success: false, 'error-codes': ['invalid-input-response'] },
      )
    },
    extra: {
      r2Buckets: { BODIES: `bodies-${crypto.randomUUID()}` },
      ...(o.limits === false ? {} : { ratelimits }),
    },
  })
  open.push(w)
  // the tracker wrangler keeps: every migration recorded, or all but the last for a database behind this build
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name).slice(0, o.behind ? -1 : undefined))
  return { w, siteverify }
}

let n = 0
/** A form of its own (a limiter's key includes the public id, so each test counts apart). */
async function seedForm(w: Workerd, over: { enabled?: boolean } = {}): Promise<string> {
  n++
  const id = `0190b2c4-0000-7000-8000-0000000f${String(n).padStart(4, '0')}`
  const publicId = `frm_${String(n).padStart(26, 'a')}`
  await seedAgent(w.d1, { id, organizationId: PAIRED_ORG, createdBy: id, name: `Form ${n}` })
  await w.d1
    .prepare(
      `insert into forms (id, created_at, updated_at, organization_id, created_by, name, public_id, enabled, email_field, name_field) values (?, ?, ?, ?, ?, ?, ?, ?, 'email', 'name')`,
    )
    .bind(id, SEEDED_AT, SEEDED_AT, PAIRED_ORG, id, `Site ${n}`, publicId, over.enabled === false ? 0 : 1)
    .run()
  await w.d1
    .prepare(
      'insert into form_allowed_origins (id, organization_id, form_id, origin, created_at) values (?, ?, ?, ?, ?)',
    )
    .bind(`0190b2c4-0000-7000-8000-0000000e${String(n).padStart(4, '0')}`, PAIRED_ORG, id, ORIGIN, SEEDED_AT)
    .run()
  return publicId
}

interface Opts {
  method?: string
  origin?: string | null
  /** `undefined`: no header at all. */
  ip?: string
  body?: string
  headers?: Record<string, string>
}
const send = (w: Workerd, path: string, o: Opts = {}) => {
  const method = o.method ?? 'POST'
  const headers: Record<string, string> = { ...o.headers }
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN
  if (o.ip !== undefined) headers['cf-connecting-ip'] = o.ip
  if (method === 'POST') headers['content-type'] ??= 'application/x-www-form-urlencoded'
  return w.mf.dispatchFetch(BASE + path, {
    method,
    headers,
    ...(method === 'POST'
      ? {
          body:
            o.body ??
            new URLSearchParams({
              email: 'ada@example.com',
              name: 'Ada',
              'cf-turnstile-response': DUMMY_TOKEN,
            }).toString(),
        }
      : {}),
  }) as unknown as Promise<Response>
}
/** A submission the honeypot answers `202` for: it exercises the limiters and nothing else. */
const HONEYPOT = new URLSearchParams({ email: 'x@example.com', _vb_hp: 'x' }).toString()
const tripped = (w: Workerd, publicId: string, ip: string) => send(w, `/f/${publicId}`, { ip, body: HONEYPOT })

describe('the route in the composed Worker (D1, P1, P2)', () => {
  let s: Started
  let id: string
  beforeAll(async () => {
    s = await start()
    id = await seedForm(s.w)
  }, 60_000)

  it('a POST with no Authorization reaches the handler: it writes its interaction under the marker organisation and answers 202', async () => {
    const res = await send(s.w, `/f/${id}`, { ip: '198.51.100.1' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'received' })
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(await s.w.rows('select channel, direction, kind, organization_id from interactions')).toEqual([
      { channel: 'form', direction: 'inbound', kind: 'message', organization_id: PAIRED_ORG },
    ])
    expect(s.siteverify).toHaveLength(1)
    expect(Object.fromEntries(s.siteverify[0]!)).toEqual({
      secret: TEST_SECRET,
      response: DUMMY_TOKEN,
      remoteip: '198.51.100.1',
    })
  })

  it('an OPTIONS from an allowed origin answers 204 with the D5 headers', async () => {
    const res = await send(s.w, `/f/${id}`, { method: 'OPTIONS', ip: '198.51.100.2' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('access-control-allow-methods')).toBe('POST')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('every method reaches the handler: a GET answers its 405, not the Worker', async () => {
    const res = await send(s.w, `/f/${id}`, { method: 'GET', ip: '198.51.100.3' })
    expect(res.status).toBe(405)
    expect(((await res.json()) as any).error.code).toBe('method_not_allowed')
  })

  it('an unknown form is the handler own 404, an unlisted origin its 403 without CORS', async () => {
    const unknown = await send(s.w, '/f/frm_doesnotexist', { ip: '198.51.100.4' })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as any).error.message).toBe('not found')
    const evil = await send(s.w, `/f/${id}`, { origin: 'https://evil.example', ip: '198.51.100.5' })
    expect(evil.status).toBe(403)
    expect(((await evil.json()) as any).error.code).toBe('origin_not_allowed')
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
  })

  it.each(['/f/a/b', '/f/', '/f', '/f/a/'])('%s is the Worker no-route 404, with no CORS headers', async (path) => {
    const res = await send(s.w, path, { ip: '198.51.100.6' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'no such route' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('the connecting IP is CF-Connecting-IP: the 11th request from one address is limited and another address is not', async () => {
    const own = await seedForm(s.w)
    for (let i = 0; i < 10; i++) expect((await tripped(s.w, own, '192.0.2.10')).status, `request ${i + 1}`).toBe(202)
    expect((await tripped(s.w, own, '192.0.2.10')).status).toBe(429)
    expect((await tripped(s.w, own, '192.0.2.11')).status).toBe(202)
  })

  it('without the header the key is unknown:<public_id> (one shared bucket), and no other header is trusted for the IP', async () => {
    const own = await seedForm(s.w)
    const ignored = (i: number): Record<string, string> => ({
      'x-forwarded-for': `203.0.113.${i}`,
      'x-real-ip': `203.0.113.${i}`,
      forwarded: `for=203.0.113.${i}`,
    })
    for (let i = 0; i < 10; i++)
      expect((await send(s.w, `/f/${own}`, { body: HONEYPOT, headers: ignored(i) })).status, `request ${i + 1}`).toBe(
        202,
      )
    expect((await send(s.w, `/f/${own}`, { body: HONEYPOT, headers: ignored(99) })).status).toBe(429)
    // an empty header is an absent one: the same bucket
    expect((await send(s.w, `/f/${own}`, { body: HONEYPOT, ip: '' })).status).toBe(429)
    // a real address has a bucket of its own
    expect((await tripped(s.w, own, '192.0.2.12')).status).toBe(202)
  })

  it('without a TURNSTILE_SECRET_KEY the challenge is unavailable: 503, no siteverify call', async () => {
    const bare = await start({ secret: null })
    const own = await seedForm(bare.w)
    const res = await send(bare.w, `/f/${own}`, { ip: '198.51.100.8' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as any).error.code).toBe('challenge_unavailable')
    expect(bare.siteverify).toHaveLength(0)
  }, 60_000)
})

describe('the gates come first (P1)', () => {
  it('migrations behind: 503 migrations_pending, no CORS headers, no limiter reached, no siteverify call', async () => {
    const s = await start({ behind: true })
    const id = await seedForm(s.w)
    // 12 requests from one address: a limiter would have answered 429 from the 11th
    for (let i = 0; i < 12; i++) {
      const res = await send(s.w, `/f/${id}`, { ip: '192.0.2.20' })
      expect(res.status, `request ${i + 1}`).toBe(503)
      expect(((await res.json()) as any).error.code).toBe('migrations_pending')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
    // the other /f paths meet the same gates before they are no-route
    expect((await send(s.w, '/f/a/b', { ip: '192.0.2.20' })).status).toBe(503)
    expect(s.siteverify).toHaveLength(0)
    expect(await s.w.rows('select id from interactions')).toEqual([])
  }, 60_000)

  it('no deployment marker: 503 not_initialised, no CORS headers, no limiter reached', async () => {
    const s = await start({ paired: false })
    for (let i = 0; i < 12; i++) {
      const res = await send(s.w, '/f/frm_aaaaaaaaaaaaaaaaaaaaaaaaaa', { ip: '192.0.2.21' })
      expect(res.status, `request ${i + 1}`).toBe(503)
      expect(((await res.json()) as any).error.code).toBe('not_initialised')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
    expect(s.siteverify).toHaveLength(0)
  }, 60_000)
})

describe('the bindings, live from the real wrangler.jsonc (D7, P4)', () => {
  it('the config declares both bindings, so the Miniflare below is the config own', () => {
    expect(Object.keys(ratelimits).sort()).toEqual(['FORM_IP_LIMITER', 'FORM_LIMITER'])
  })

  it('the 11th request in a window from one IP to one form answers 429 rate_limited with Retry-After: 60', async () => {
    const s = await start()
    const id = await seedForm(s.w)
    for (let i = 0; i < 10; i++) expect((await tripped(s.w, id, '192.0.2.30')).status).toBe(202)
    const res = await tripped(s.w, id, '192.0.2.30')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(((await res.json()) as any).error.code).toBe('rate_limited')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  }, 60_000)

  it('a preflight counts against the limiters too', async () => {
    const s = await start()
    const id = await seedForm(s.w)
    for (let i = 0; i < 10; i++)
      expect((await send(s.w, `/f/${id}`, { method: 'OPTIONS', ip: '192.0.2.31' })).status).toBe(204)
    expect((await send(s.w, `/f/${id}`, { method: 'OPTIONS', ip: '192.0.2.31' })).status).toBe(429)
  }, 60_000)

  it('11 requests from 11 IPs do not trip it; the per-form limit is 60 in a window, whatever the address', async () => {
    const s = await start()
    const id = await seedForm(s.w)
    for (let i = 1; i <= 60; i++) expect((await tripped(s.w, id, `198.18.0.${i}`)).status, `request ${i}`).toBe(202)
    const res = await tripped(s.w, id, '198.18.0.200')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    // another form has its own count
    const other = await seedForm(s.w)
    expect((await tripped(s.w, other, '198.18.0.200')).status).toBe(202)
  }, 120_000)

  it('with no bindings the route serves unthrottled', async () => {
    const s = await start({ limits: false })
    const id = await seedForm(s.w)
    for (let i = 0; i < 25; i++) expect((await tripped(s.w, id, '192.0.2.40')).status, `request ${i + 1}`).toBe(202)
  }, 60_000)
})
