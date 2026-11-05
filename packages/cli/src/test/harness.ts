import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../cli.js'
import type { Deps, Sink } from '../types.js'
import { apiDoc, metaDoc, wellKnown } from './fixtures.js'

export interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  redirect: string
}
export interface Result {
  code: number
  stdout: string
  stderr: string
  stdoutBytes: Uint8Array
}
type Handler = (req: Request) => Response | Promise<Response> | undefined

/** A scratch config and cache directory, and a `run` that records every outgoing request. */
export function rig(opts: { fetch: (req: Request) => Response | Promise<Response>; env?: Record<string, string>; tty?: boolean; stdin?: string; stdinTTY?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'vibase-cli-'))
  const seen: Seen[] = []
  // Like the real fetch: a 3xx is an error under redirect 'error', and is followed (headers kept, as a hostile server would hope) otherwise.
  const fetchImpl = (async (input: any, init?: any) => {
    let req = new Request(input, init)
    for (let hops = 0; ; hops++) {
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => (headers[k] = v))
      seen.push({ url: req.url, method: req.method, headers, redirect: req.redirect })
      const res = await opts.fetch(req)
      const location = res.headers.get('location')
      if (res.status < 300 || res.status > 399 || !location || req.redirect === 'manual') return res
      if (req.redirect === 'error') throw new TypeError('unexpected redirect')
      if (hops > 5) throw new TypeError('too many redirects')
      req = new Request(new URL(location, req.url), { method: 'GET', headers: req.headers })
    }
  }) as typeof fetch
  const sleeps: number[] = []
  const outputs: { argv: string[]; stdout: string; stderr: string }[] = []
  const configFile = join(dir, 'vibase', 'config.json')
  const cacheDir = join(dir, 'vibase')
  let clock = 1_800_000_000_000
  const go = async (argv: string[], over: { env?: Record<string, string | undefined>; stdin?: string; tty?: boolean; stdinTTY?: boolean; sleep?: (ms: number) => Promise<void> } = {}): Promise<Result> => {
    let stdinRead = 0
    const out: (string | Uint8Array)[] = []
    const err: string[] = []
    const stdout: Sink = { isTTY: over.tty ?? opts.tty ?? false, write: (c) => void out.push(c) }
    const stderr: Sink = { isTTY: false, write: (c) => void err.push(typeof c === 'string' ? c : Buffer.from(c).toString()) }
    const deps: Deps = {
      fetch: fetchImpl,
      env: { XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, ...opts.env, ...over.env },
      stdout,
      stderr,
      // Like process.stdin: a second read of the same run finds the stream ended.
      readStdin: async () => (stdinRead++ === 0 ? (over.stdin ?? opts.stdin ?? '') : ''),
      stdinIsTTY: over.stdinTTY ?? opts.stdinTTY ?? false,
      now: () => clock,
      // Default: time passes at once (the fake clock moves by `ms`); a test that needs real interleaving passes `sleep`.
      sleep: async (ms) => {
        sleeps.push(ms)
        if (over.sleep) return over.sleep(ms)
        clock += ms
        await new Promise((r) => setTimeout(r, 0))
      },
      homedir: dir,
      version: '0.0.0-test',
    }
    const code = await run(argv, deps)
    const bytes = Buffer.concat(out.map((c) => (typeof c === 'string' ? Buffer.from(c) : Buffer.from(c))))
    outputs.push({ argv, stdout: bytes.toString('utf8'), stderr: err.join('') })
    return { code, stdout: bytes.toString('utf8'), stderr: err.join(''), stdoutBytes: new Uint8Array(bytes) }
  }
  return {
    dir,
    configFile,
    cacheDir,
    seen,
    sleeps,
    /** Every run's stdout and stderr, for assertions that must hold in all of them. */
    outputs,
    now: () => clock,
    run: go,
    advance: (ms: number) => void (clock += ms),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export const KEY = ['vk', 'cli'.repeat(12)].join('_')
export const SERVER = 'http://127.0.0.1:8787'
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
export { json }

/** A fake instance at `origin`: the discovery document, both OpenAPI documents and routes supplied by the test. */
export function fakeInstance(opts: { origin?: string; routes?: Handler; wellKnown?: (origin: string) => Response | unknown; api?: unknown; meta?: unknown } = {}) {
  const counts = { wellKnown: 0, api: 0, meta: 0 }
  const fetch = async (req: Request): Promise<Response> => {
    const u = new URL(req.url)
    const origin = opts.origin ?? u.origin
    if (u.pathname === '/.well-known/vibase') {
      counts.wellKnown++
      const body = opts.wellKnown ? opts.wellKnown(origin) : wellKnown(origin)
      return body instanceof Response ? body : json(body)
    }
    if (u.pathname.endsWith('/openapi.json')) {
      if (u.pathname.startsWith('/api/')) return counts.api++, json(opts.api ?? apiDoc())
      return counts.meta++, json(opts.meta ?? metaDoc())
    }
    return (await opts.routes?.(req)) ?? json({ error: { code: 'not_found', message: 'no such route' } }, 404)
  }
  return { fetch, counts }
}
