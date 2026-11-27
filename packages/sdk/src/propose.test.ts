import { describe, expect, it } from 'vitest'
import { createClient, isVibaseError } from './index.js'
import { BASE, fakeFetch, jsonResponse } from './testing.js'

// DX608 D11 (P4): .propose() calls action_requests.create.
const record = { id: 'ar1', status: 'pending', operation: 'tasks.update', arguments: { id: 't1', description: null } }

describe('DX608 D11 .propose()', () => {
  it('POSTs action_requests.create with the operation id, the flat args and the proposal fields', async () => {
    const fetch = fakeFetch(() => jsonResponse(record, 201))
    const vibase = createClient({ url: BASE, auth: 'tok', fetch })
    const args = { id: 't1', notes: null, title: 'x' }
    const result = await vibase.tasks.update.propose(args, { reason: 'because', dedup_key: 'k' })
    expect(result).toEqual(record)
    expect(fetch.calls).toHaveLength(1)
    const call = fetch.calls[0]
    expect(call.init.method).toBe('POST')
    expect(new URL(call.url).pathname).toBe('/api/v1/action-requests')
    expect(JSON.parse(call.init.body as string)).toEqual({
      reason: 'because',
      dedup_key: 'k',
      operation: 'tasks.update',
      arguments: args,
    })
  })

  it('takes the signal option', async () => {
    const fetch = fakeFetch(() => jsonResponse(record, 201))
    const vibase = createClient({ url: BASE, auth: 'tok', fetch })
    const controller = new AbortController()
    await vibase.tasks.delete.propose({ id: 't1' }, { reason: 'r' }, { signal: controller.signal })
    expect(fetch.calls[0].init.signal).toBe(controller.signal)
  })

  it('a server error maps by D8', async () => {
    const fetch = fakeFetch(() => jsonResponse({ error: { code: 'validation_error', message: 'bad' } }, 400))
    const vibase = createClient({ url: BASE, auth: 'tok', fetch })
    const error = await vibase.tasks.update.propose({ id: 't1' }, { reason: 'r' }).catch((e) => e)
    expect(isVibaseError(error)).toBe(true)
    expect([error.status, error.code, error.message]).toEqual([400, 'validation_error', 'bad'])
  })

  it('is absent on a non-proposable operation', () => {
    const vibase = createClient({ url: BASE, auth: 'tok', fetch: fakeFetch(() => jsonResponse({})) }) as any
    expect(vibase.tasks.list.propose).toBeUndefined()
    expect(vibase.tasks.update.all).toBeUndefined()
  })
})
