import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COVERED_WRITERS, EXCLUDED_DYNAMIC_WRITERS } from '../test/guarded-kit.js'

// [[CORE565]] 565.3 (obligation 5): the writer inventory. Every non-test module under `packages/api/src` that writes contacts, companies, deals or tasks is found by what it does (grep), never by a list, and must be in the
// adversarial contract's covered list: a new system writer cannot join the codebase without joining the contract.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const TABLES = '(contacts|companies|deals|tasks)'
/** A literal write verb on one of the four tables (Kysely builder or raw sql), a prepared program's `after: { table }`, or a write verb on a table that is not a literal (a definition's table, a catalog entry). */
const LITERAL = new RegExp(`(?:insertInto|updateTable|deleteFrom)\\(\\s*['"]${TABLES}['"]`)
const RAW = new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from)\\s+"${TABLES}"`, 'i')
const AFTER = new RegExp(`after:\\s*\\{\\s*table:\\s*['"]${TABLES}['"]`)
const DYNAMIC = /(?:insertInto|updateTable|deleteFrom)\(\s*[^'"\s)]/

const isTestSupport = (path: string) =>
  /\.(test|suite|typecheck)\.tsx?$/.test(path) ||
  /\.(test|suite|typecheck)\.ts$/.test(path) ||
  /(^|\/)test\//.test(path)
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}
/** The non-test modules, as `src`-relative paths, that write the four tables, and those whose writes name a table the scan cannot read. */
export function scanWriters(root = SRC) {
  const literal: string[] = []
  const dynamic: string[] = []
  for (const file of walk(root)) {
    const rel = relative(root, file)
    if (isTestSupport(rel)) continue
    const text = stripComments(readFileSync(file, 'utf8'))
    if (LITERAL.test(text) || RAW.test(text) || AFTER.test(text)) literal.push(rel)
    else if (DYNAMIC.test(text)) dynamic.push(rel)
  }
  return { literal: literal.sort(), dynamic: dynamic.sort() }
}

/** The writers the contract does not cover: a module found by the scan that is neither covered nor a recorded exclusion, and a covered module the scan no longer finds. */
const drift = (scan: ReturnType<typeof scanWriters>, covered: readonly string[]) => {
  const writers = [...scan.literal, ...scan.dynamic.filter((m) => !(m in EXCLUDED_DYNAMIC_WRITERS))].sort()
  return { uncovered: writers.filter((m) => !covered.includes(m)), stale: covered.filter((m) => !writers.includes(m)) }
}

describe('the writer inventory', () => {
  const found = scanWriters()
  it('finds the writers by what they do: the scan sees the known writers and no test module', () => {
    expect(found.literal).toEqual(
      expect.arrayContaining([
        'identity/resolve.ts',
        'identity/merge.ts',
        'forms/submission.ts',
        'deals/move-stage.ts',
      ]),
    )
    expect([...found.literal, ...found.dynamic].filter(isTestSupport)).toEqual([])
  })
  it('every module that writes the four tables is in the contract covered list, and the list names no module that does not', () => {
    expect(drift(found, Object.keys(COVERED_WRITERS))).toEqual({ uncovered: [], stale: [] })
  })
  it('an excluded dynamic writer still exists and still writes through a table it does not name literally', () => {
    expect(Object.keys(EXCLUDED_DYNAMIC_WRITERS).sort()).toEqual(
      found.dynamic.filter((m) => m in EXCLUDED_DYNAMIC_WRITERS),
    )
  })
  it('a new writer module is found by what it does and fails the comparison until it joins the covered list; a dropped entry does too', () => {
    const root = mkdtempSync(join(tmpdir(), 'writers-'))
    try {
      mkdirSync(join(root, 'scratch'))
      writeFileSync(
        join(root, 'scratch/new-writer.ts'),
        'export const w = (qc) => qc.db.insertInto("deals").values({})',
      )
      writeFileSync(join(root, 'scratch/raw-writer.ts'), 'export const q = sql`update "tasks" set "title" = 1`')
      writeFileSync(
        join(root, 'scratch/reader.ts'),
        '// update "tasks" in prose\nexport const r = qc.db.selectFrom("tasks")',
      )
      const seen = scanWriters(root)
      expect(seen.literal).toEqual(['scratch/new-writer.ts', 'scratch/raw-writer.ts'])
      expect(drift(seen, ['scratch/new-writer.ts'])).toEqual({ uncovered: ['scratch/raw-writer.ts'], stale: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    const covered = Object.keys(COVERED_WRITERS)
    expect(drift(found, covered.slice(1)).uncovered).toEqual([covered[0]])
  })
  it('every covered writer names the suite that proves it, and that suite exists', () => {
    for (const [module, proof] of Object.entries(COVERED_WRITERS)) {
      expect(proof.length, module).toBeGreaterThan(0)
      for (const suite of proof) expect(() => statSync(join(SRC, suite)), `${module} -> ${suite}`).not.toThrow()
    }
  })
})
