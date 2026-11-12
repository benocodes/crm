// [[API215]] / [[API6]] D9: `vibase events tail` against a fake feed that follows events.list's contract (`after`, `limit`, `next_cursor`).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../../api/src/operations.js'
import { createApp } from '../../api/src/rest/app.js'
import { coldStorage } from '../../api/src/test/storage.js'
import { fakeInstance, json, KEY, rig, SERVER } from './test/harness.js'

const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})

const id = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const ev = (n: number, type = 'task.created') => ({ id: id(n), type, resource_type: 'task', resource_id: id(1000 + n) })

let apiDocPromise: Promise<any> | undefined
const apiDoc = () => (apiDocPromise ??= (async () => (await createApp({ storage: coldStorage(), registry: createVaultRegistry() }).request('/api/v1/openapi.json')).json())())

interface Feed {
  events: ReturnType<typeof ev>[]
  /** Answers the nth events request (0-based) instead of the feed. */
  override?: (n: number, url: URL) => Response | undefined
  requests: URL[]
}

/** The feed: pages of `limit` (default 2) after the id in `after`. An unknown `after` is `invalid_cursor`. */
async function setup(feed: Feed, opts: { withoutEvents?: boolean } = {}) {
  const api = structuredClone(await apiDoc())
  if (opts.withoutEvents) for (const p of Object.keys(api.paths)) if (p.startsWith('/api/v1/events')) delete api.paths[p]
  const instance = fakeInstance({
    api,
    routes: (req) => {
      const u = new URL(req.url)
      if (u.pathname !== '/api/v1/events') return undefined
      const n = feed.requests.length
      feed.requests.push(u)
      const o = feed.override?.(n, u)
      if (o) return o
      const limit = Number(u.searchParams.get('limit') ?? 2)
      const after = u.searchParams.get('after')
      let from = 0
      if (after) {
        const i = feed.events.findIndex((e) => e.id === after)
        if (i < 0) return json({ error: { code: 'invalid_cursor', message: 'the cursor does not name an event' } }, 400)
        from = i + 1
      }
      const slice = feed.events.slice(from, from + limit)
      const more = from + limit < feed.events.length
      return json({ data: slice, next_cursor: more ? slice[slice.length - 1]!.id : null })
    },
  })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  const file = join(r.dir, 'cursor')
  return { r, file }
}
const newFeed = (n: number): Feed => ({ events: Array.from({ length: n }, (_, i) => ev(i + 1)), requests: [] })
const lines = (s: string) => s.split('\n').filter((l) => l !== '')
const ids = (s: string) => lines(s).map((l) => JSON.parse(l).id)

describe('catch-up', () => {
  it('pages through the whole feed, one compact JSON line per event in order, exit 0', async () => {
    const feed = newFeed(5)
    const { r } = await setup(feed)
    const res = await r.run(['events', 'tail', '--limit', '2'])
    expect(res.code, res.stderr).toBe(0)
    expect(ids(res.stdout)).toEqual([1, 2, 3, 4, 5].map(id))
    expect(lines(res.stdout).map((l) => l)).toEqual(feed.events.map((e) => JSON.stringify(e)))
    expect(feed.requests).toHaveLength(3)
    expect(feed.requests[0]!.searchParams.has('after')).toBe(false)
    expect(feed.requests[1]!.searchParams.get('after')).toBe(id(2))
    expect(feed.requests[2]!.searchParams.get('after')).toBe(id(4))
  })

  it('prints compact lines even on a terminal', async () => {
    const { r } = await setup(newFeed(1))
    const res = await r.run(['events', 'tail'], { tty: true })
    expect(res.stdout).toBe(JSON.stringify(ev(1)) + '\n')
  })

  it('an empty feed prints nothing and exits 0', async () => {
    const { r } = await setup(newFeed(0))
    const res = await r.run(['events', 'tail'])
    expect(res).toMatchObject({ code: 0, stdout: '', stderr: '' })
  })

  it('--after starts after the given event', async () => {
    const feed = newFeed(4)
    const { r } = await setup(feed)
    const res = await r.run(['events', 'tail', '--after', id(2)])
    expect(ids(res.stdout)).toEqual([id(3), id(4)])
    expect(feed.requests[0]!.searchParams.get('after')).toBe(id(2))
  })

  it('the filters and --limit reach the query string unchanged', async () => {
    const feed = newFeed(0)
    const { r } = await setup(feed)
    const res = await r.run(['events', 'tail', '--type', 'task.updated', '--resource-type', 'task', '--resource-id', id(7), '--limit', '5'])
    expect(res.code, res.stderr).toBe(0)
    expect(Object.fromEntries(feed.requests[0]!.searchParams)).toEqual({ type: 'task.updated', resource_type: 'task', resource_id: id(7), limit: '5' })
  })

  it('sends the bearer credential on the same request path as every command', async () => {
    const feed = newFeed(1)
    const { r } = await setup(feed)
    const res = await r.run(['events', 'tail'])
    expect(res.code).toBe(0)
    const sent = r.seen.filter((x) => new URL(x.url).pathname === '/api/v1/events')
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(sent[0]!.redirect).toBe('error')
  })
})

describe('cursor file', () => {
  it('a missing file starts from --after, and after each event the file holds its id (id plus newline)', async () => {
    const feed = newFeed(3)
    const { r, file } = await setup(feed)
    const res = await r.run(['events', 'tail', '--after', id(1), '--cursor-file', file])
    expect(ids(res.stdout)).toEqual([id(2), id(3)])
    expect(readFileSync(file, 'utf8')).toBe(id(3) + '\n')
  })

  it('an empty file starts from the feed start', async () => {
    const feed = newFeed(2)
    const { r, file } = await setup(feed)
    writeFileSync(file, '')
    const res = await r.run(['events', 'tail', '--cursor-file', file])
    expect(ids(res.stdout)).toEqual([id(1), id(2)])
  })

  it('a non-empty file wins over --after', async () => {
    const feed = newFeed(4)
    const { r, file } = await setup(feed)
    writeFileSync(file, id(3) + '\n')
    const res = await r.run(['events', 'tail', '--after', id(1), '--cursor-file', file])
    expect(ids(res.stdout)).toEqual([id(4)])
    expect(feed.requests[0]!.searchParams.get('after')).toBe(id(3))
  })

  it('a second run after new events prints only the later ones', async () => {
    const feed = newFeed(2)
    const { r, file } = await setup(feed)
    expect(ids((await r.run(['events', 'tail', '--cursor-file', file])).stdout)).toEqual([id(1), id(2)])
    feed.events.push(ev(3), ev(4))
    expect(ids((await r.run(['events', 'tail', '--cursor-file', file])).stdout)).toEqual([id(3), id(4)])
    expect((await r.run(['events', 'tail', '--cursor-file', file])).stdout).toBe('')
  })

  it('persists per event: a failure on the second page leaves the file at the last printed event, and the resume does not reprint the first page', async () => {
    const feed = newFeed(5)
    feed.override = (n) => (n === 1 ? json({ error: { code: 'internal', message: 'boom' } }, 500) : undefined)
    const { r, file } = await setup(feed)
    const first = await r.run(['events', 'tail', '--limit', '2', '--cursor-file', file])
    expect(first.code).toBe(1)
    expect(ids(first.stdout)).toEqual([id(1), id(2)])
    expect(readFileSync(file, 'utf8')).toBe(id(2) + '\n')
    feed.override = undefined
    const second = await r.run(['events', 'tail', '--limit', '2', '--cursor-file', file])
    expect(ids(second.stdout)).toEqual([id(3), id(4), id(5)])
  })

  it('replaces the file by rename: a write that cannot complete leaves the old content, and no temp file stays behind on success', async () => {
    const feed = newFeed(2)
    const { r, file } = await setup(feed)
    writeFileSync(file, id(0) + '\n')
    feed.events.unshift(ev(0))
    // The temp name is taken by a directory, so the write fails before any rename.
    mkdirSync(file + '.tmp')
    const bad = await r.run(['events', 'tail', '--cursor-file', file])
    expect(bad.code).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe(id(0) + '\n')
    const dir = join(r.dir, 'ok')
    mkdirSync(dir)
    const good = await r.run(['events', 'tail', '--cursor-file', join(dir, 'c')])
    expect(good.code).toBe(0)
    expect(readdirSync(dir)).toEqual(['c'])
    expect(existsSync(join(dir, 'c.tmp'))).toBe(false)
  })

  it('a malformed file is a usage error naming the file, before any request is made', async () => {
    for (const content of ['nope\n', id(1) + '\n' + id(2) + '\n']) {
      const feed = newFeed(2)
      const { r, file } = await setup(feed)
      writeFileSync(file, content)
      const res = await r.run(['events', 'tail', '--cursor-file', file])
      expect(res.code).toBe(2)
      expect(res.stderr).toContain(file)
      expect(res.stdout).toBe('')
      expect(feed.requests).toHaveLength(0)
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  })
})

describe('--follow', () => {
  it('sleeps the interval (default 5 s) after the drained feed and polls again after the last printed id', async () => {
    const feed = newFeed(2)
    const { r } = await setup(feed)
    const ac = new AbortController()
    let polls = 0
    const res = await r.run(['events', 'tail', '--follow'], {
      signal: ac.signal,
      sleep: async () => {
        if (++polls === 1) feed.events.push(ev(3))
        if (polls === 3) ac.abort()
      },
    })
    expect(res.code, res.stderr).toBe(0)
    expect(ids(res.stdout)).toEqual([id(1), id(2), id(3)])
    expect(r.sleeps[0]).toBe(5000)
    expect(feed.requests.map((u) => u.searchParams.get('after'))).toEqual([null, id(2), id(3)])
  })

  it('--interval sets the sleep', async () => {
    const { r } = await setup(newFeed(0))
    const ac = new AbortController()
    const res = await r.run(['events', 'tail', '--follow', '--interval', '1.5'], { signal: ac.signal, sleep: async () => ac.abort() })
    expect(res.code).toBe(0)
    expect(r.sleeps).toEqual([1500])
  })

  it('polls after the last printed id, never from before a printed event', async () => {
    const feed = newFeed(1)
    const { r } = await setup(feed)
    const ac = new AbortController()
    let polls = 0
    const res = await r.run(['events', 'tail', '--follow', '--after', id(1)], {
      signal: ac.signal,
      sleep: async () => {
        polls++
        if (polls === 1) feed.events.push(ev(2))
        if (polls === 2) feed.events.push(ev(3))
        if (polls === 3) ac.abort()
      },
    })
    expect(ids(res.stdout)).toEqual([id(2), id(3)])
    expect(feed.requests.map((u) => u.searchParams.get('after'))).toEqual([id(1), id(1), id(2)])
  })

  it('keeps the cursor file current while following', async () => {
    const feed = newFeed(1)
    const { r, file } = await setup(feed)
    const ac = new AbortController()
    await r.run(['events', 'tail', '--follow', '--cursor-file', file], {
      signal: ac.signal,
      sleep: async () => {
        feed.events.push(ev(2))
        if (feed.requests.length > 1) ac.abort()
      },
    })
    expect(readFileSync(file, 'utf8')).toBe(id(2) + '\n')
  })

  it('an API error while following ends the run with exit 1', async () => {
    const feed = newFeed(1)
    feed.override = (n) => (n === 1 ? json({ error: { code: 'internal', message: 'boom' } }, 500) : undefined)
    const { r } = await setup(feed)
    const res = await r.run(['events', 'tail', '--follow'], { sleep: async () => undefined })
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stderr).error.code).toBe('internal')
  })
})

describe('errors and usage', () => {
  it('a stale cursor file: invalid_cursor on stderr, exit 1, file unchanged', async () => {
    const { r, file } = await setup(newFeed(2))
    writeFileSync(file, id(99) + '\n')
    const res = await r.run(['events', 'tail', '--cursor-file', file])
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stderr)).toEqual({ error: { code: 'invalid_cursor', message: 'the cursor does not name an event' } })
    expect(readFileSync(file, 'utf8')).toBe(id(99) + '\n')
  })

  it('403 insufficient_scope: the API error on stderr, exit 1, file unchanged', async () => {
    const feed = newFeed(2)
    feed.override = () => json({ error: { code: 'insufficient_scope', message: 'needs events:read' } }, 403)
    const { r, file } = await setup(feed)
    writeFileSync(file, id(1) + '\n')
    const res = await r.run(['events', 'tail', '--cursor-file', file])
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stderr).error.code).toBe('insufficient_scope')
    expect(res.stdout).toBe('')
    expect(readFileSync(file, 'utf8')).toBe(id(1) + '\n')
  })

  it('a network failure: exit 1 with network_error, file unchanged', async () => {
    const feed = newFeed(2)
    feed.override = () => {
      throw new TypeError('fetch failed')
    }
    const { r, file } = await setup(feed)
    const res = await r.run(['events', 'tail', '--cursor-file', file])
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stderr).error.code).toBe('network_error')
    expect(existsSync(file)).toBe(false)
  })

  it.each([
    [['--interval', '3']],
    [['--follow', '--interval', '0']],
    [['--follow', '--interval', '0.5']],
    [['--follow', '--interval', 'x']],
    [['--bogus']],
    [['--all']],
    [['extra']],
    [['--limit', 'x']],
  ])('usage error, exit 2, no request: %j', async (extra) => {
    const feed = newFeed(1)
    const { r } = await setup(feed)
    const res = await r.run(['events', 'tail', ...extra])
    expect(res.code).toBe(2)
    expect(JSON.parse(res.stderr).error.code).toBe('usage')
    expect(feed.requests).toHaveLength(0)
  })

  it('an instance whose documents lack events.list: exit 2', async () => {
    const { r } = await setup(newFeed(1), { withoutEvents: true })
    const res = await r.run(['events', 'tail'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('events')
  })

  it('no credential on stdout or stderr', async () => {
    const feed = newFeed(2)
    const { r, file } = await setup(feed)
    writeFileSync(file, id(99) + '\n')
    await r.run(['events', 'tail', '--cursor-file', file])
    await r.run(['events', 'tail'])
    for (const o of r.outputs) {
      expect(o.stdout).not.toContain(KEY)
      expect(o.stderr).not.toContain(KEY)
    }
  })
})

describe('surface', () => {
  it('events --help and vibase --help mention tail, and the derived list/get remain', async () => {
    const { r } = await setup(newFeed(0))
    const events = await r.run(['events', '--help'])
    expect(events.code).toBe(0)
    expect(events.stdout).toMatch(/tail/)
    expect(events.stdout).toMatch(/list/)
    expect(events.stdout).toMatch(/get/)
    expect((await r.run(['--help'])).stdout).toMatch(/events tail/)
    const help = await r.run(['events', 'tail', '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('--cursor-file')
    expect(help.stdout).toContain('--follow')
  })

  it('events list still derives and runs', async () => {
    const feed = newFeed(1)
    const { r } = await setup(feed)
    const res = await r.run(['events', 'list'])
    expect(res.code, res.stderr).toBe(0)
    expect(JSON.parse(res.stdout).data[0].id).toBe(id(1))
  })
})
