// `pnpm dev` ([[UI489]] D7, P2): builds the pages once, starts the local Worker (`wrangler dev --local --port 8787`, serving the built pages as before) and the Vite dev server on :5173 in front of it.
// If the build fails nothing starts; if either process exits the other is stopped and `dev` exits non-zero; a signal stops both. Arguments after `--` go to `wrangler dev`.
import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEV_PORT, startDevServer, WORKER_PORT } from './dev-server.js'

const PKG = fileURLToPath(new URL('..', import.meta.url))

export interface DevChild {
  /** Resolves with the exit code when the process ends (for any reason, including `stop`). */
  exited: Promise<number>
  stop(): Promise<void>
}
export interface DevDeps {
  build(): Promise<number>
  startWorker(args: string[]): DevChild
  startDevServer(): Promise<DevChild>
  /** Registers the stop signal handler (SIGINT, SIGTERM); returns the unregister function. */
  onSignal(handler: () => void): () => void
  log(line: string): void
}

/** Runs the dev session and resolves with its exit code (0 after a signal, non-zero after a build failure or a child's exit). */
export async function runDev(args: string[], deps: DevDeps): Promise<number> {
  const extra = args[0] === '--' ? args.slice(1) : args
  let stopRequested: (() => void) | undefined
  const signalled = new Promise<'signal'>((r) => {
    stopRequested = () => r('signal')
  })
  const off = deps.onSignal(() => stopRequested?.())
  try {
    const built = await Promise.race([deps.build(), signalled])
    if (built === 'signal') return 0
    if (built !== 0) {
      deps.log(`dev: the page build failed (exit ${built}); nothing was started`)
      return built
    }
    const worker = deps.startWorker(['--local', '--port', String(WORKER_PORT), ...extra])
    let server: DevChild
    try {
      server = await deps.startDevServer()
    } catch (e) {
      deps.log(`dev: the dev server did not start: ${(e as Error).message}`)
      await worker.stop()
      return 1
    }
    deps.log(`dev: open http://localhost:${DEV_PORT}/home (the built pages and the API stay on http://localhost:${WORKER_PORT})`)
    const first = await Promise.race([
      worker.exited.then((code) => ({ who: 'worker' as const, code })),
      server.exited.then((code) => ({ who: 'server' as const, code })),
      signalled.then(() => ({ who: 'signal' as const, code: 0 })),
    ])
    if (first.who !== 'worker') await worker.stop()
    if (first.who !== 'server') await server.stop()
    if (first.who === 'signal') return 0
    deps.log(`dev: the ${first.who === 'worker' ? 'Worker' : 'dev server'} exited (${first.code}); stopped the other`)
    return first.code || 1
  } finally {
    off()
  }
}

const exitOf = (p: ChildProcess): Promise<number> =>
  new Promise((resolve) => {
    p.once('error', () => resolve(1))
    p.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })

/** A spawned command as a `DevChild`: its own process group, so `stop` takes wrangler's workerd with it. */
function spawnChild(command: string, args: string[]): DevChild {
  const p = spawn(command, args, { cwd: PKG, stdio: 'inherit', detached: true })
  const exited = exitOf(p)
  return {
    exited,
    async stop() {
      if (p.exitCode !== null || p.signalCode !== null) return
      try {
        process.kill(-p.pid!, 'SIGTERM')
      } catch {
        p.kill('SIGTERM')
      }
      await exited
    },
  }
}

export const realDeps: DevDeps = {
  build: () => spawnChild('pnpm', ['run', 'build']).exited,
  startWorker: (args) => spawnChild('pnpm', ['exec', 'wrangler', 'dev', ...args]),
  async startDevServer() {
    const server = await startDevServer({ upstream: `http://localhost:${WORKER_PORT}` })
    return { exited: new Promise<number>(() => {}), stop: () => server.close() }
  },
  onSignal(handler) {
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
    return () => {
      process.off('SIGINT', handler)
      process.off('SIGTERM', handler)
    }
  },
  log: (line) => console.log(line),
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await runDev(process.argv.slice(2), realDeps))
}
