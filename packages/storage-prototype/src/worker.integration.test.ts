import { test, expect } from 'vitest'
import { harness, fault } from './test/backend.js'
test('actual module Worker batch and in-worker pre-SQL admission', async () => {
  const h = await harness('d1')
  try {
    const before: any = await h.seed()
    await h.clearEvents()
    const p = h.compileTask(before.id, { title: 'Worker' })
    const result = await h.runtime.execute(p)
    expect(result.value.title).toBe('Worker')
    expect(result.metrics.physicalRequests).toBe(1)
    const mf = (h as any).mf
    const response = await mf.dispatchFetch('http://local/a', {
      method: 'POST',
      body: JSON.stringify({ ...p, context: h.b }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ statements: 0 })
    const counts = await h.counts()
    await expect(h.runtime.execute(fault(p, 'result'))).rejects.toThrow()
    expect(await h.counts()).toEqual(counts)
  } finally {
    await h.close()
  }
})
