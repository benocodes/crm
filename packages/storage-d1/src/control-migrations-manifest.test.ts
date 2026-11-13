import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTROL_MIGRATIONS } from './control-migrations-manifest.js'
import { MIGRATIONS } from './migrations-manifest.js'
import { CONTROL_MIGRATIONS_DIR } from './test/index.js'

type Entry = { readonly name: string; readonly sha256: string }

/** The same comparison the CRM manifest test makes ([[CORE61]] D5), against the control directory ([[CORE259]] D4). */
function manifestProblems(manifest: readonly Entry[], dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const problems: string[] = []
  for (const e of manifest) {
    if (!files.includes(e.name)) {
      problems.push(`manifest entry without a file: ${e.name}`)
      continue
    }
    const actual = createHash('sha256').update(readFileSync(join(dir, e.name))).digest('hex')
    if (actual !== e.sha256) problems.push(`hash mismatch: ${e.name}`)
  }
  for (const f of files) if (!manifest.some((e) => e.name === f)) problems.push(`file without a manifest entry: ${f}`)
  if (problems.length === 0 && manifest.map((e) => e.name).join() !== files.join()) problems.push('order differs from the sorted file names')
  return problems
}

const copies: string[] = []
function copyOfTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'control-manifest-'))
  copies.push(dir)
  for (const f of readdirSync(CONTROL_MIGRATIONS_DIR)) copyFileSync(join(CONTROL_MIGRATIONS_DIR, f), join(dir, f))
  return dir
}
afterEach(() => {
  for (const d of copies.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('control migrations manifest (CORE259 D4)', () => {
  it('matches the real control-migrations/ directory exactly, and is its own set apart from the CRM one', () => {
    expect(manifestProblems(CONTROL_MIGRATIONS, CONTROL_MIGRATIONS_DIR)).toEqual([])
    expect(CONTROL_MIGRATIONS.map((e) => e.name)).toEqual(['0001_control_plane.sql'])
    expect(CONTROL_MIGRATIONS.map((e) => e.name).filter((n) => MIGRATIONS.some((m) => m.name === n))).toEqual([])
  })
  it('catches one edited byte', () => {
    const dir = copyOfTree()
    writeFileSync(join(dir, '0001_control_plane.sql'), readFileSync(join(dir, '0001_control_plane.sql'), 'utf-8') + ' ')
    expect(manifestProblems(CONTROL_MIGRATIONS, dir)).toEqual(['hash mismatch: 0001_control_plane.sql'])
  })
  it('catches a dropped manifest entry (a file the manifest does not list)', () => {
    expect(manifestProblems(CONTROL_MIGRATIONS.slice(1), copyOfTree())).toEqual(['file without a manifest entry: 0001_control_plane.sql'])
  })
  it('catches an unlisted file', () => {
    const dir = copyOfTree()
    writeFileSync(join(dir, '0002_stray.sql'), 'select 1;')
    expect(manifestProblems(CONTROL_MIGRATIONS, dir)).toEqual(['file without a manifest entry: 0002_stray.sql'])
  })
  it('catches an entry without a file', () => {
    const dir = copyOfTree()
    rmSync(join(dir, '0001_control_plane.sql'))
    expect(manifestProblems(CONTROL_MIGRATIONS, dir)).toEqual(['manifest entry without a file: 0001_control_plane.sql'])
  })
})
