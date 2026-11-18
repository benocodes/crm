import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SITEVERIFY_URL, siteverifyVerifier } from './turnstile.js'

// [[CHN432]] D6, P3a, P3b (432.4, 432.5): the `fetch` Turnstile verifier, over a faked `fetch`.
const SECRET = 'sk-secret-value-not-to-leak'
const TOKEN = 'tok-token-value-not-to-leak'

interface Call {
  url: string
  init: RequestInit
}
const fetcher = (answer: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return { calls, fake }
}
const reply = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

const logged: string[] = []
beforeEach(() => {
  logged.length = 0
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const run = async (answer: Parameters<typeof fetcher>[0], ip?: string, secret: string | undefined = SECRET) => {
  const f = fetcher(answer)
  const verdict = await siteverifyVerifier({ secret, fetch: f.fake }).verify(
    ip ? { token: TOKEN, ip } : { token: TOKEN },
  )
  return { verdict, ...f }
}

describe('verdicts (matrix)', () => {
  it('passed carries the hostname', async () => {
    const r = await run(() => reply({ success: true, hostname: 'example.com' }))
    expect(r.verdict).toEqual({ outcome: 'passed', hostname: 'example.com' })
    expect(r.calls).toHaveLength(1)
  })

  it.each([
    ['success false, an ordinary code', { success: false, 'error-codes': ['invalid-input-response'] }],
    ['success false, no codes', { success: false }],
    ['success true without a hostname', { success: true }],
    ['success true with a non-string hostname', { success: true, hostname: 42 }],
    ['timeout-or-duplicate', { success: false, 'error-codes': ['timeout-or-duplicate'] }],
  ])('rejected: %s', async (_name, body) => {
    const r = await run(() => reply(body))
    expect(r.verdict).toEqual({ outcome: 'rejected' })
    expect(r.calls).toHaveLength(1)
  })

  it.each(['missing-input-secret', 'invalid-input-secret', 'internal-error'])(
    'unavailable: error code %s',
    async (code) => {
      const r = await run(() => reply({ success: false, 'error-codes': [code] }))
      expect(r.verdict).toEqual({ outcome: 'unavailable' })
      expect(r.calls).toHaveLength(1)
    },
  )

  it('unavailable: an unavailable code among others', async () => {
    const r = await run(() => reply({ success: false, 'error-codes': ['invalid-input-response', 'internal-error'] }))
    expect(r.verdict).toEqual({ outcome: 'unavailable' })
  })

  it('unavailable: a 500', async () => {
    const r = await run(() => reply({ success: true, hostname: 'example.com' }, 500))
    expect(r.verdict).toEqual({ outcome: 'unavailable' })
    expect(r.calls).toHaveLength(1)
  })

  it('unavailable: a non-JSON body', async () => {
    const r = await run(() => reply('<html>bad gateway</html>'))
    expect(r.verdict).toEqual({ outcome: 'unavailable' })
    expect(r.calls).toHaveLength(1)
  })

  it('unavailable: a body that is JSON but not an object', async () => {
    const r = await run(() => reply('null'))
    expect(r.verdict).toEqual({ outcome: 'unavailable' })
  })

  it('unavailable: a rejected fetch', async () => {
    const r = await run(() => Promise.reject(new TypeError('network down')))
    expect(r.verdict).toEqual({ outcome: 'unavailable' })
    expect(r.calls).toHaveLength(1)
  })

  it('unavailable: a fetch that throws synchronously', async () => {
    const throwing = (() => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    expect(await siteverifyVerifier({ secret: SECRET, fetch: throwing }).verify({ token: TOKEN })).toEqual({
      outcome: 'unavailable',
    })
  })

  it('unavailable: a hang past 5 s, on one attempt', async () => {
    vi.useFakeTimers()
    const f = fetcher(() => new Promise<Response>(() => {}))
    let settled: unknown
    const p = siteverifyVerifier({ secret: SECRET, fetch: f.fake })
      .verify({ token: TOKEN })
      .then((v) => (settled = v))
    await vi.advanceTimersByTimeAsync(4999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2)
    await p
    expect(settled).toEqual({ outcome: 'unavailable' })
    expect(f.calls).toHaveLength(1)
  })

  it('the timeout aborts the request through its signal', async () => {
    vi.useFakeTimers()
    const f = fetcher(() => new Promise<Response>(() => {}))
    const p = siteverifyVerifier({ secret: SECRET, fetch: f.fake }).verify({ token: TOKEN })
    await vi.advanceTimersByTimeAsync(5001)
    await p
    expect((f.calls[0]!.init.signal as AbortSignal).aborted).toBe(true)
  })

  it.each([undefined, ''])('unavailable with zero fetches for the secret %j', async (secret) => {
    const r = await run(() => reply({ success: true, hostname: 'example.com' }), undefined, secret)
    expect(r.verdict).toEqual({ outcome: 'unavailable' })
    expect(r.calls).toHaveLength(0)
  })
})

describe('the request', () => {
  it('is a form-encoded POST to the exact URL, with remoteip only when the IP is known', async () => {
    const withIp = await run(() => reply({ success: true, hostname: 'example.com' }), '203.0.113.7')
    expect(withIp.calls[0]!.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(SITEVERIFY_URL).toBe(withIp.calls[0]!.url)
    expect(withIp.calls[0]!.init.method).toBe('POST')
    const headers = new Headers(withIp.calls[0]!.init.headers)
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    const sent = new URLSearchParams(String(withIp.calls[0]!.init.body))
    expect(Object.fromEntries(sent)).toEqual({ secret: SECRET, response: TOKEN, remoteip: '203.0.113.7' })

    const noIp = await run(() => reply({ success: true, hostname: 'example.com' }))
    const sent2 = new URLSearchParams(String(noIp.calls[0]!.init.body))
    expect(Object.fromEntries(sent2)).toEqual({ secret: SECRET, response: TOKEN })
    expect(sent2.has('remoteip')).toBe(false)
  })

  it('never logs the secret or the token, on any outcome', async () => {
    await run(() => reply({ success: true, hostname: 'example.com' }))
    await run(() => reply({ success: false, 'error-codes': ['invalid-input-secret'] }))
    await run(() => Promise.reject(new Error(`failed for ${SECRET}`)))
    await run(() => reply('garbage'))
    await run(() => reply({}, 500))
    await run(() => reply({}), undefined, undefined)
    expect(logged.join('\n')).not.toContain(SECRET)
    expect(logged.join('\n')).not.toContain(TOKEN)
  })

  it('never throws, whatever the answer', async () => {
    for (const answer of [
      () => Promise.reject('a string'),
      () => Promise.reject(undefined),
      () => reply({ success: true, hostname: {} }),
    ])
      await expect(run(answer)).resolves.toBeDefined()
  })
})
