// Test support ([[CORE243]]): bundle a Worker entry the way a deploy does (esbuild; `node:` imports stay external, which `nodejs_compat` resolves in
// workerd) and run it in Miniflare against a migrated in-memory D1, with no network.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare, type MiniflareOptions } from 'miniflare'
import { applyMigrations } from '@vault/storage-d1/test'
import type { D1Like } from '@vault/storage-d1'

export interface Bundle {
  dir: string
  path: string
  bytes: number
  /** Every distinct `node:` specifier the bundle imports. */
  nodeImports: string[]
  dispose(): void
}

export const NODE_IMPORT = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:[^"']+)["']/g

export async function bundleWorker(entry: string): Promise<Bundle> {
  const dir = mkdtempSync(join(tmpdir(), 'vault-auth-bundle-'))
  const path = join(dir, 'worker.mjs')
  await build({
    entryPoints: [entry],
    outfile: path,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    target: 'es2022',
    external: ['cloudflare:workers', 'node:*'],
    logLevel: 'warning',
  })
  const text = readFileSync(path, 'utf8')
  return { dir, path, bytes: statSync(path).size, nodeImports: [...new Set([...text.matchAll(NODE_IMPORT)].map((m) => m[1]!))].sort(), dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

export const BASE = 'http://localhost:8787'
export const SECRET = 'test-auth-secret-0123456789-abcdefghij-klmnop'

export interface Workerd {
  mf: Miniflare
  d1: D1Like
  logs: string[]
  call(path: string, init?: { method?: string; body?: unknown; form?: boolean; cookie?: string; headers?: Record<string, string> }): Promise<Response>
  rows<T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]): Promise<T[]>
  dispose(): Promise<void>
}

export async function startWorkerd(o: { bundle: Bundle; bindings?: Record<string, string>; flags?: string[]; migrate?: boolean }): Promise<Workerd> {
  const logs: string[] = []
  const capture = (stream: NodeJS.ReadableStream) => stream.on('data', (c: Buffer) => logs.push(...c.toString().split('\n').filter(Boolean)))
  const options: MiniflareOptions = {
    port: 0,
    modules: true,
    scriptPath: o.bundle.path,
    modulesRoot: o.bundle.dir,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: o.flags ?? ['nodejs_compat'],
    d1Databases: { DB: `auth-${crypto.randomUUID()}` },
    d1Persist: false,
    bindings: { AUTH_SECRET: SECRET, PUBLIC_BASE_URL: BASE, ...o.bindings },
    handleRuntimeStdio: (stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream) => {
      capture(stdout)
      capture(stderr)
    },
    outboundService: () => {
      throw new Error('the auth tests make no outbound request')
    },
  }
  const mf = new Miniflare(options)
  try {
    await mf.ready
    const d1 = (await mf.getD1Database('DB')) as unknown as D1Like
    if (o.migrate !== false) await applyMigrations(d1)
    return {
      mf,
      d1,
      logs,
      call: (path, init = {}) =>
        mf.dispatchFetch(BASE + path, {
          method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
          headers: { origin: BASE, 'cf-connecting-ip': '203.0.113.9', ...(init.body === undefined ? {} : { 'content-type': init.form ? 'application/x-www-form-urlencoded' : 'application/json' }), ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
          body: init.body === undefined ? undefined : init.form ? new URLSearchParams(init.body as Record<string, string>).toString() : JSON.stringify(init.body),
        }) as unknown as Promise<Response>,
      rows: async <T>(sqlText: string, ...binds: unknown[]) => ((await d1.prepare(sqlText).bind(...binds).all()).results ?? []) as T[],
      dispose: () => mf.dispose(),
    }
  } catch (err) {
    await mf.dispose()
    throw err
  }
}
