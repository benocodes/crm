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

const ENTERPRISE = ['pg', '@vault/db', '@vault/storage-postgres', '@vault/api']

export const RULES: readonly Rule[] = [
  // The portable core: no driver, no enterprise code, no runtime, no API.
  { dir: 'storage/src', forbid: [...ENTERPRISE, '@vault/storage-d1'], allow: { 'import-boundary.test.ts': 'holds forbidden imports as test data' } },
  // The D1 runtime is open: no `pg`, no enterprise runtime, no Postgres tenancy package, no API barrel.
  { dir: 'storage-d1/src', forbid: ENTERPRISE },
  // The domain programs (open): production code never imports the enterprise runtime or `pg`.
  {
    dir: 'api/src',
    forbid: ['pg', '@vault/storage-postgres'],
    skipTests: true,
    allow: { 'dev-server.ts': 'composition entry point: picks the Postgres runtime; moves out at the CORE37 cutover (spec D21)' },
  },
  {
    dir: 'api/scripts',
    forbid: ['pg', '@vault/storage-postgres'],
    allow: {
      'golden.ts': 'enterprise-side fixture generator: runs the Postgres path by design (D17)',
      'smoke-auth.ts': 'smoke entry point composing the Postgres runtime; moves at the CORE37 cutover (D21)',
      'smoke-admin.ts': 'smoke entry point composing the Postgres runtime; moves at the CORE37 cutover (D21)',
      'bootstrap.ts': 'bootstrap CLI composing the Postgres runtime; TEMPORARY: moves to @vault/server-postgres in CORE44 (CORE41 P14)',
    },
  },
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

const isTest = (path: string): boolean => /\.(test|integration\.test)\.ts$/.test(path) || /[\\/]test[\\/]/.test(path)

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
