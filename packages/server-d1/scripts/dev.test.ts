import { describe, expect, it } from 'vitest'
import { runDev, type DevChild, type DevDeps } from './dev.js'

// [[UI489]] D7, P2 (group 5): `pnpm dev`'s runner with its process starts injected.
interface Rig {
  deps: DevDeps
  events: string[]
  logs: string[]
  worker: Fake
  server: Fake
  signal(): void
}
interface Fake extends DevChild {
  exit(code: number): void
  stopped: boolean
}
const fake = (name: string, events: string[]): Fake => {
  let resolve!: (c: number) => void
  const f: Fake = {
    exited: new Promise<number>((r) => {
      resolve = r
    }),
    stopped: false,
    exit: (c) => resolve(c),
    async stop() {
      f.stopped = true
      events.push(`stop ${name}`)
      resolve(0)
    },
  }
  return f
}
function rig(opts: { buildCode?: number } = {}): Rig {
  const events: string[] = []
  const logs: string[] = []
  const worker = fake('worker', events)
  const server = fake('server', events)
  let handler: (() => void) | undefined
  const deps: DevDeps = {
    async build() {
      events.push('build')
      return opts.buildCode ?? 0
    },
    startWorker(args) {
      events.push(`worker ${args.join(' ')}`)
      return worker
    },
    async startDevServer() {
      events.push('server')
      return server
    },
    onSignal(h) {
      handler = h
      return () => {
        handler = undefined
      }
    },
    log: (l) => logs.push(l),
  }
  return { deps, events, logs, worker, server, signal: () => handler?.() }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('runDev', () => {
  it('builds first, then starts the Worker with --local --port 8787 plus the arguments after --, then the dev server, and prints the URL', async () => {
    const r = rig()
    const done = runDev(['--', '--persist-to', 'x'], r.deps)
    await tick()
    expect(r.events).toEqual(['build', 'worker --local --port 8787 --persist-to x', 'server'])
    expect(r.logs.join('\n')).toContain('http://localhost:5173/home')
    r.signal()
    await done
  })

  it('without extra arguments the Worker command is today’s', async () => {
    const r = rig()
    const done = runDev([], r.deps)
    await tick()
    expect(r.events[1]).toBe('worker --local --port 8787')
    r.signal()
    await done
  })

  it('a build failure starts nothing and exits non-zero', async () => {
    const r = rig({ buildCode: 2 })
    const code = await runDev([], r.deps)
    expect(code).not.toBe(0)
    expect(r.events).toEqual(['build'])
  })

  it('if the Worker exits, the dev server is stopped and the exit is non-zero', async () => {
    const r = rig()
    const done = runDev([], r.deps)
    await tick()
    r.worker.exit(0)
    expect(await done).not.toBe(0)
    expect(r.server.stopped).toBe(true)
    expect(r.worker.stopped).toBe(false)
  })

  it('if the dev server exits, the Worker is stopped and the exit is non-zero', async () => {
    const r = rig()
    const done = runDev([], r.deps)
    await tick()
    r.server.exit(1)
    expect(await done).not.toBe(0)
    expect(r.worker.stopped).toBe(true)
  })

  it('a signal stops both', async () => {
    const r = rig()
    const done = runDev([], r.deps)
    await tick()
    r.signal()
    await done
    expect(r.worker.stopped).toBe(true)
    expect(r.server.stopped).toBe(true)
  })
})
