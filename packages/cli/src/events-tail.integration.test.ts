import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { composeD1Worker } from '@vault/server-d1/compose'
import { bootstrapD1 } from '@vault/server-d1/bootstrap'
import { openWorkerD1, type WorkerD1 } from '@vault/server-d1/test'
import { rig, SERVER } from './test/harness.js'

// [[API215]]: `vibase events tail` against the real D1 app in process, with real events and a restart.
let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})
let key: string
beforeEach(async () => {
  await w.reset()
  const b = await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'none', authOrgId: 'e2e', email: 'e2e@example.com', agentName: 'e2e-agent', scopes: ['events:read', 'tasks:read', 'tasks:write', 'schema:read'] })
  key = b.key
})

it('catches up over real events page by page, resumes from the cursor file, and follows', async () => {
  const worker = composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '' })
  const r = rig({ fetch: (req) => worker.fetch(req) })
  rigs.push(r)
  expect((await r.run(['login', '--api-key', '--server', SERVER], { stdin: key + '\n' })).code).toBe(0)
  const file = join(r.dir, 'cursor')
  const tail = (extra: string[] = []) => r.run(['events', 'tail', '--limit', '1', '--cursor-file', file, ...extra])
  const task = async (title: string) => expect((await r.run(['tasks', 'create', '--title', title])).code).toBe(0)

  expect(await tail()).toMatchObject({ code: 0, stdout: '', stderr: '' })
  await task('a')
  await task('b')
  const first = await tail()
  expect(first.code, first.stderr).toBe(0)
  const events = first.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  expect(events.map((e) => e.type)).toEqual(['task.created', 'task.created'])
  expect(readFileSync(file, 'utf8')).toBe(events[1].id + '\n')

  await task('c')
  const ac = new AbortController()
  let polls = 0
  const followed = await r.run(['events', 'tail', '--limit', '1', '--cursor-file', file, '--follow', '--interval', '1'], {
    signal: ac.signal,
    sleep: async () => {
      if (++polls === 1) await task('d')
      else ac.abort()
    },
  })
  expect(followed.code, followed.stderr).toBe(0)
  const later = followed.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  expect(later.map((e) => e.type)).toEqual(['task.created', 'task.created'])
  expect(r.sleeps).toEqual([1000, 1000])
  expect(r.outputs.every((o) => !o.stdout.includes(key) && !o.stderr.includes(key))).toBe(true)
})
