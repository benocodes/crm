// The import-boundary check ([[CORE35]] D14/D15, Step 3.1). Open packages never import enterprise code, `pg` or
// Postgres-specific packages; the portable core imports no runtime. Dependencies point one way: enterprise may
// import open packages, never the reverse.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface Rule {
  /** Directory, relative to the packages root, whose TypeScript files the rule covers. */
  dir: string
  /** Specifiers (exact or `prefix/`) that must not be imported. */
  forbid: readonly string[]
  /** Files (relative to `dir`) exempt from the rule, each with the reason it is allowed. */
  allow?: Readonly<Record<string, string>>
  /** Skip test files (the Postgres suites are the behaviour oracle and may use the enterprise runtime). */
  skipTests?: boolean
}

const ENTERPRISE = ['pg', '@vault/db', '@vault/storage-postgres', '@vault/server-postgres', '@vault/api']

export const RULES: readonly Rule[] = [
  // The portable core: no driver, no enterprise code, no runtime, no API.
  { dir: 'storage/src', forbid: [...ENTERPRISE, '@vault/storage-d1'], allow: { 'import-boundary.test.ts': 'holds forbidden imports as test data' } },
  // The D1 runtime is open: no `pg`, no enterprise runtime, no Postgres tenancy package, no API barrel.
  { dir: 'storage-d1/src', forbid: ENTERPRISE },
  // The domain programs (open): production code and scripts never import enterprise code or `pg`, and the rules have no allow-list
  // ([[CORE36]] D22): the Postgres composition lives in @vault/server-postgres. `api/scripts` is empty and the rule guards it.
  { dir: 'api/src', forbid: ['pg', '@vault/db', '@vault/storage-postgres', '@vault/server-postgres'], skipTests: true },
  { dir: 'api/scripts', forbid: ['pg', '@vault/db', '@vault/storage-postgres', '@vault/server-postgres'] },
  // The built-in auth provider ([[CORE243]] D21): open, never imports enterprise code or `pg`; no allow-list.
  { dir: 'auth/src', forbid: ['pg', '@vault/db', '@vault/storage-postgres', '@vault/server-postgres'], skipTests: true },
  { dir: 'auth/scripts', forbid: ['pg', '@vault/db', '@vault/storage-postgres', '@vault/server-postgres'] },
  // The open D1 Worker composition ([[CORE38]] D1): it composes @vault/api (allowed) and never the enterprise runtime or `pg`.
  { dir: 'server-d1/src', forbid: ['pg', '@vault/db', '@vault/storage-postgres', '@vault/server-postgres'], skipTests: true },
  { dir: 'server-d1/scripts', forbid: ['pg', '@vault/db', '@vault/storage-postgres', '@vault/server-postgres'] },
]

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

function* files(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) yield path
  }
}

const forbidden = (specifier: string, forbid: readonly string[]): boolean =>
  forbid.some((f) => specifier === f || specifier.startsWith(`${f}/`))

// `.suite.ts` is a both-engine suite body (OPS92 D3): test code, imported only by `*.d1.test.ts` and `*.postgres.test.ts` entry files.
const isTest = (path: string): boolean => /\.(test|suite)\.ts$/.test(path) || /[\\/]test[\\/]/.test(path)

export interface Violation {
  file: string
  specifier: string
  rule: string
}

/** Scans `packagesRoot` (the repo's `packages/` directory) and returns every forbidden import. */
export function checkBoundary(packagesRoot: string, rules: readonly Rule[] = RULES): Violation[] {
  const out: Violation[] = []
  for (const rule of rules) {
    const base = join(packagesRoot, rule.dir)
    for (const file of files(base)) {
      const rel = relative(base, file)
      if (rule.allow && (rel in rule.allow || '' in rule.allow)) continue
      if (rule.skipTests && isTest(file)) continue
      const text = readFileSync(file, 'utf-8')
      for (const m of text.matchAll(SPECIFIER)) {
        if (forbidden(m[1]!, rule.forbid)) out.push({ file: relative(packagesRoot, file), specifier: m[1]!, rule: rule.dir })
      }
    }
  }
  return out
}

/** Test files that hold forbidden imports as data (strings), each with the reason. */
const NAMING_EXEMPT: Readonly<Record<string, string>> = { 'storage/src/import-boundary.test.ts': 'holds forbidden imports as test data' }
export const POSTGRES_INTEGRATION = '<integration test in a Postgres package>'
const POSTGRES_CODE = ['pg', '@vault/db', '@vault/storage-postgres', '@vault/server-postgres']
const TYPE_ONLY_IMPORT = /\bimport\s+type\b[^;'"]*?\bfrom\s+['"][^'"]+['"]/gs

/**
 * The engine-naming rule (OPS92 D2): a `*.test.ts` file with no `.postgres.` infix (engine-neutral, or `.d1.`) runs in the
 * default projects, which need no Postgres server, so it must not import Postgres code. Type-only imports are erased and
 * allowed. Non-test helpers are not checked: a helper may import Postgres code as long as no default-project test file does.
 */
export function checkEngineNaming(packagesRoot: string): Violation[] {
  const out: Violation[] = []
  for (const file of files(packagesRoot)) {
    if (!/\.test\.ts$/.test(file) || /\.postgres\.test\.ts$/.test(file)) continue
    const rel = relative(packagesRoot, file)
    if (rel in NAMING_EXEMPT) continue
    // Inside the Postgres packages an `.integration.` test is database-backed by definition, whatever it imports (relative helpers hide it).
    if (/\.integration\.test\.ts$/.test(file) && /^(db|storage-postgres)[\\/]/.test(rel)) out.push({ file: rel, specifier: POSTGRES_INTEGRATION, rule: 'engine-naming' })
    const text = readFileSync(file, 'utf-8').replace(TYPE_ONLY_IMPORT, '')
    for (const m of text.matchAll(SPECIFIER)) {
      if (forbidden(m[1]!, POSTGRES_CODE)) out.push({ file: rel, specifier: m[1]!, rule: 'engine-naming' })
    }
  }
  return out
}
