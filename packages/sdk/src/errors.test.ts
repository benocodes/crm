import { describe, expect, it } from 'vitest'
import { createClient, isVibaseError, VibaseError } from './index.js'
import { BASE, fakeFetch, jsonResponse } from './testing.js'

// DX603 D8: every failure rejects with a VibaseError.
const run = (handler: Parameters<typeof fakeFetch>[0], signal?: AbortSignal) =>
  createClient({ url: BASE, auth: 't', fetch: fakeFetch(handler) })
    .contacts.get({ id: 'x' }, { signal })
    .catch((e) => e)

describe('DX603 D8 errors', () => {
  it('keeps the API error envelope: status, code, message', async () => {
    const error = await run(() => jsonResponse({ error: { code: 'not_found', message: 'No such contact' } }, 404))
    expect(error).toBeInstanceOf(VibaseError)
    expect(error).toMatchObject({ status: 404, code: 'not_found', message: 'No such contact' })
  })

  it('maps a non-JSON non-2xx to http_<status> with an excerpt', async () => {
    const error = await run(() => new Response('<html>Bad gateway</html>'.repeat(100), { status: 502 }))
    expect(error).toMatchObject({ status: 502, code: 'http_502' })
    expect(error.message).toContain('502')
    expect(error.message).toContain('Bad gateway')
    expect(error.message.length).toBeLessThan(300)
  })

  it('maps a JSON non-2xx without an error envelope to http_<status>', async () => {
    const error = await run(() => jsonResponse({ detail: 'x' }, 500))
    expect(error).toMatchObject({ status: 500, code: 'http_500' })
  })

  it('maps a fetch rejection to status 0 network_error', async () => {
    const error = await run(() => {
      throw new TypeError('fetch failed')
    })
    expect(error).toBeInstanceOf(VibaseError)
    expect(error).toMatchObject({ status: 0, code: 'network_error' })
    expect(error.message).toContain('fetch failed')
  })

  it('maps a 2xx with unparseable JSON to invalid_response', async () => {
    const error = await run(() => new Response('not json', { status: 200 }))
    expect(error).toMatchObject({ code: 'invalid_response' })
    expect(error).toBeInstanceOf(VibaseError)
  })

  it('rethrows an abort as the AbortError, not a VibaseError', async () => {
    const controller = new AbortController()
    const error = await run(({ init }) => {
      controller.abort()
      throw init.signal?.reason
    }, controller.signal)
    expect(error).not.toBeInstanceOf(VibaseError)
    expect(error.name).toBe('AbortError')
  })

  it('isVibaseError is true only for the class', () => {
    expect(isVibaseError(new VibaseError(400, 'x', 'y'))).toBe(true)
    expect(isVibaseError(new Error('x'))).toBe(false)
    expect(isVibaseError({ status: 400, code: 'x', message: 'y' })).toBe(false)
    expect(isVibaseError(null)).toBe(false)
  })
})
