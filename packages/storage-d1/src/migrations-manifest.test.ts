import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations-manifest.js'
import { MIGRATIONS_DIR } from './test/index.js'

type Entry = { readonly name: string; readonly sha256: string }

/** Every way the manifest and the migration files can disagree ([[CORE61]] D5); empty means they agree. */
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
  const dir = mkdtempSync(join(tmpdir(), 'manifest-'))
  copies.push(dir)
  for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f))
  return dir
}
afterEach(() => {
  for (const d of copies.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('migrations manifest (D5)', () => {
  it('matches the real migrations/ directory', () => {
    expect(manifestProblems(MIGRATIONS, MIGRATIONS_DIR)).toEqual([])
    expect(MIGRATIONS.map((e) => e.name)).toEqual(['0001_typed_storage_core.sql', '0002_identity_model.sql', '0003_administration.sql', '0004_messaging_model.sql'])
  })
  it('catches one edited byte', () => {
    const dir = copyOfTree()
    writeFileSync(join(dir, '0002_identity_model.sql'), readFileSync(join(dir, '0002_identity_model.sql'), 'utf-8') + ' ')
    expect(manifestProblems(MIGRATIONS, dir)).toEqual(['hash mismatch: 0002_identity_model.sql'])
  })
  it('catches a dropped manifest entry', () => {
    expect(manifestProblems(MIGRATIONS.slice(1), copyOfTree())).toEqual(['file without a manifest entry: 0001_typed_storage_core.sql'])
  })
  it('catches an unlisted file', () => {
    const dir = copyOfTree()
    writeFileSync(join(dir, '0005_new.sql'), 'select 1;')
    expect(manifestProblems(MIGRATIONS, dir)).toEqual(['file without a manifest entry: 0005_new.sql'])
  })
  it('catches an entry without a file', () => {
    const dir = copyOfTree()
    rmSync(join(dir, '0004_messaging_model.sql'))
    expect(manifestProblems(MIGRATIONS, dir)).toEqual(['manifest entry without a file: 0004_messaging_model.sql'])
  })
  it('catches a swapped order', () => {
    const swapped = [MIGRATIONS[1]!, MIGRATIONS[0]!, ...MIGRATIONS.slice(2)]
    expect(manifestProblems(swapped, copyOfTree())).toEqual(['order differs from the sorted file names'])
  })
})
