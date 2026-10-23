// Test-only: disposable local D1 bindings over Miniflare (workerd). Nothing here can reach a remote database:
// bindings are created in-process, in memory, with a throwaway id, and disposed in `finally`.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Miniflare } from 'miniflare'
import type { D1Like } from '../binding.js'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))

/** Splits a migration file into statements. The files hold no triggers, so `;` at a line end is a boundary. */
export function splitStatements(sqlText: string): string[] {
  const noComments = sqlText
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
  return noComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Applies every `NNNN_*.sql` file, in order, the way `wrangler d1 migrations apply` would. */
export async function applyMigrations(d1: D1Like, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
  for (const file of files) {
    const statements = splitStatements(readFileSync(join(dir, file), 'utf-8'))
    if (statements.length > 0) await d1.batch(statements.map((s) => d1.prepare(s)))
  }
  return files
}

export interface LocalD1 {
  /** One binding per name; each is its own database (never two tenants in one D1). */
  readonly bindings: Readonly<Record<string, D1Like>>
  dispose(): Promise<void>
}

/** Starts local D1 databases `names`, migrated, and hands them to `fn`; always disposed. */
export async function withLocalD1<T>(names: readonly string[], fn: (local: LocalD1) => Promise<T>, opts: { migrate?: boolean } = {}): Promise<T> {
  const local = await openLocalD1(names, opts)
  try {
    return await fn(local)
  } finally {
    await local.dispose()
  }
}

/** Like `withLocalD1` for a suite that keeps the bindings across tests: the caller must `dispose()`. */
export async function openLocalD1(names: readonly string[], opts: { migrate?: boolean } = {}): Promise<LocalD1> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("local d1") } }',
    d1Databases: Object.fromEntries(names.map((n) => [n, `local-${n}-${crypto.randomUUID()}`])),
  })
  try {
    const bindings: Record<string, D1Like> = {}
    for (const name of names) {
      const d1 = (await mf.getD1Database(name)) as unknown as D1Like
      if (opts.migrate !== false) await applyMigrations(d1)
      bindings[name] = d1
    }
    return { bindings, dispose: () => mf.dispose() }
  } catch (err) {
    await mf.dispose()
    throw err
  }
}

/** Empties every table the migrations created (children first) and keeps the schema. */
export async function clearD1(d1: D1Like): Promise<void> {
  const { results } = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()
  const tables = new Set((results ?? []).map((r) => (r as { name: string }).name))
  const order = ['events', 'tasks', 'users', 'principals', 'organizations', 'deployment']
  const known = order.filter((t) => tables.has(t))
  const rest = [...tables].filter((t) => !order.includes(t))
  const statements = [...rest, ...known].map((t) => d1.prepare(`DELETE FROM "${t}"`))
  if (statements.length > 0) await d1.batch(statements)
}
