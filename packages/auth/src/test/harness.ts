// Test support ([[CORE243]]): bundle a Worker entry the way a deploy does (esbuild; `node:` imports stay external, which `nodejs_compat` resolves in
// workerd) and run it in Miniflare against a migrated in-memory D1, with no network.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare, type MiniflareOptions } from 'miniflare'
import { applyControlMigrations, applyMigrations } from '@vibase/storage-d1/test'
import { openControlDb, writeControlMarker, type D1Like } from '@vibase/storage-d1'
import { seedDeployment } from '@vibase/storage-d1/test/seed'

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
  const dir = mkdtempSync(join(tmpdir(), 'vb-auth-bundle-'))
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
  /** The CRM database (`DB`). */
  d1: D1Like
  /** The control-plane database (`CONTROL_DB`, [[CORE259]]): where every `auth_*` row lives. Absent when started with `control: false`. */
  control: D1Like
  logs: string[]
  call(path: string, init?: { method?: string; body?: unknown; form?: boolean; cookie?: string; headers?: Record<string, string> }): Promise<Response>
  /** A query on the CRM database. */
  rows<T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]): Promise<T[]>
  /** A query on the control-plane database. */
  controlRows<T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]): Promise<T[]>
  dispose(): Promise<void>
}

/** The organisation both markers name when a harness pairs the two databases. */
export const PAIRED_ORG = '0190b2c4-0000-7000-8000-00000000a0ff'

export async function startWorkerd(o: {
  bundle: Bundle
  bindings?: Record<string, string>
  flags?: string[]
  migrate?: boolean
  /** `false`: no `CONTROL_DB` binding at all (the Worker's fail-closed row). Default true. */
  control?: boolean
  /** `true`: write the CRM `deployment` row and the control marker for `PAIRED_ORG`, as bootstrap does. Default false (the test entry needs neither). */
  paired?: boolean
}): Promise<Workerd> {
  const logs: string[] = []
  const capture = (stream: NodeJS.ReadableStream) => stream.on('data', (c: Buffer) => logs.push(...c.toString().split('\n').filter(Boolean)))
  const options: MiniflareOptions = {
    port: 0,
    // Explicit modules: Better Auth's Kysely adapter has `import(variable)` (for `node:sqlite`) that Miniflare's own module scan refuses; wrangler and workerd are fine with it.
    modules: [{ type: 'ESModule', path: o.bundle.path, contents: readFileSync(o.bundle.path, 'utf8') }],
    modulesRoot: o.bundle.dir,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: o.flags ?? ['nodejs_compat'],
    d1Databases: { DB: `auth-${crypto.randomUUID()}`, ...(o.control === false ? {} : { CONTROL_DB: `auth-control-${crypto.randomUUID()}` }) },
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
    const control = (o.control === false ? d1 : ((await mf.getD1Database('CONTROL_DB')) as unknown as D1Like))
    if (o.migrate !== false) {
      await applyMigrations(d1)
      if (o.control !== false) await applyControlMigrations(control)
    }
    if (o.paired === true) {
      await seedDeployment(d1, { organizationId: PAIRED_ORG, provider: 'better-auth', externalId: 'org_paired' })
      await writeControlMarker(openControlDb(control), PAIRED_ORG)
    }
    return {
      mf,
      d1,
      control,
      logs,
      call: (path, init = {}) =>
        mf.dispatchFetch(BASE + path, {
          method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
          headers: { origin: BASE, 'cf-connecting-ip': '203.0.113.9', ...(init.body === undefined ? {} : { 'content-type': init.form ? 'application/x-www-form-urlencoded' : 'application/json' }), ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
          body: init.body === undefined ? undefined : init.form ? new URLSearchParams(init.body as Record<string, string>).toString() : JSON.stringify(init.body),
        }) as unknown as Promise<Response>,
      rows: async <T>(sqlText: string, ...binds: unknown[]) => ((await d1.prepare(sqlText).bind(...binds).all()).results ?? []) as T[],
      controlRows: async <T>(sqlText: string, ...binds: unknown[]) => ((await control.prepare(sqlText).bind(...binds).all()).results ?? []) as T[],
      dispose: () => mf.dispose(),
    }
  } catch (err) {
    await mf.dispose()
    throw err
  }
}
