// [[UI447]] D5 (group 3): no workspace manifest declares Preact; one negative fixture per forbidden name, and per field.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkManifests, preactDeclarations } from './test/manifest-scan'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

describe('manifest guard', () => {
  it('the real tree passes: the root and every packages/* manifest declare no Preact', () => {
    expect(checkManifests(ROOT)).toEqual([])
  })

  it('reads the root package.json and every packages/* manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { preact: '1' } }))
    for (const p of ['a', 'b']) {
      mkdirSync(join(root, 'packages', p), { recursive: true })
      writeFileSync(join(root, 'packages', p, 'package.json'), JSON.stringify({ dependencies: { preact: '1' } }))
    }
    expect(checkManifests(root).map((x) => x.file).sort()).toEqual(
      ['package.json', 'packages/a/package.json', 'packages/b/package.json'].sort(),
    )
  })

  it.each(['preact', '@preact/signals', '@testing-library/preact'])('refuses %s', (name) => {
    expect(preactDeclarations('x', { dependencies: { [name]: '1.0.0' } })).toEqual([
      { file: 'x', field: 'dependencies', name },
    ])
  })

  it.each(['devDependencies', 'peerDependencies', 'optionalDependencies'])('refuses a name in %s', (field) => {
    expect(preactDeclarations('x', { [field]: { preact: '1.0.0' } })).toEqual([{ file: 'x', field, name: 'preact' }])
  })

  it('accepts the React packages', () => {
    expect(preactDeclarations('x', { dependencies: { react: '1', '@testing-library/react': '1' } })).toEqual([])
  })
})
