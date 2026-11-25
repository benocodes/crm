import { type ApiKeyKit, openApiKeyKit } from '@vibase/api/test/api-key'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createClient, isVibaseError } from './index.js'

// DX608 P6: the SDK against the real app on D1, authenticated by a real API key the app verifies (control store, not a stubbed principal).
let k: ApiKeyKit
let vibase: ReturnType<typeof createClient>
beforeAll(async () => {
  k = await openApiKeyKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  const agentId = await k.seedAgent()
  await k.e
    .d1!.prepare('update agents set scopes = ? where id = ?')
    .bind(JSON.stringify(['tasks:read', 'tasks:write', 'action_requests:read', 'action_requests:write']), agentId)
    .run()
  const { key } = await k.ctlKey({ agent_id: agentId })
  vibase = createClient({
    url: 'https://api.acme.example',
    auth: key,
    fetch: ((url: string, init: RequestInit) => k.app.request(url, init)) as typeof fetch,
  })
})

const make = async (titles: string[]) => {
  const out = []
  for (const title of titles) out.push(await vibase.tasks.create({ title }))
  return out
}
const titles = (page: { data: { title: string }[] }) => page.data.map((t) => t.title).sort()

describe('DX608 round trip on D1', () => {
  it('a range filter returns exactly the expected subset', async () => {
    await make(['a', 'b', 'c', 'd'])
    const page = await vibase.tasks.list({ title: { gte: 'b', lt: 'd' } })
    expect(titles(page)).toEqual(['b', 'c'])
  })

  it('an in filter with a quoted item and a not filter return the expected rows', async () => {
    await make(['plain', 'a,b', 'say "hi"', 'other'])
    const inPage = await vibase.tasks.list({ title: { in: ['a,b', 'say "hi"'] } })
    expect(titles(inPage)).toEqual(['a,b', 'say "hi"'])
    const notPage = await vibase.tasks.list({ title: { not: { in: ['a,b', 'say "hi"'] } } })
    expect(titles(notPage)).toEqual(['other', 'plain'])
    const bare = await vibase.tasks.list({ title: 'is.gd' })
    expect(bare.data).toEqual([])
  })

  it('.all() with a small limit yields every record across more than one page', async () => {
    await make(['t1', 't2', 't3', 't4', 't5'])
    const seen: string[] = []
    for await (const task of vibase.tasks.list.all({ limit: 2 })) seen.push(task.title)
    expect(seen.sort()).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })

  it('.propose creates a pending action request storing the operation and arguments', async () => {
    const [task] = await make(['original'])
    const args = { id: task.id, title: 'renamed' }
    const request = await vibase.tasks.update.propose(args, { reason: 'tidy up' })
    expect(request.status).toBe('pending')
    expect(request.operation).toBe('tasks.update')
    expect(request.arguments).toEqual(args)
    const stored = await vibase.actionRequests.get({ id: request.id })
    expect([stored.operation, stored.arguments, stored.status]).toEqual(['tasks.update', args, 'pending'])
    expect((await vibase.tasks.get({ id: task.id })).title).toBe('original')
  })

  it('a proposal with invalid arguments is refused as a VibaseError with the server status and code', async () => {
    const error = await vibase.tasks.update
      .propose({ id: 'not-a-task', title: 5 as never }, { reason: 'bad' })
      .catch((e) => e)
    expect(isVibaseError(error)).toBe(true)
    expect(error.status).toBeGreaterThanOrEqual(400)
    expect(error.status).toBeLessThan(500)
    expect(error.code).not.toMatch(/^http_/)
  })

  it('a get of a missing id throws VibaseError 404 with the envelope code', async () => {
    const error = await vibase.tasks.get({ id: '0190b2c4-0000-7000-8000-00000000dead' }).catch((e) => e)
    expect(isVibaseError(error)).toBe(true)
    expect([error.status, error.code]).toEqual([404, 'not_found'])
  })
})
