import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// DX694 D4: the generator core is dependency-free.
const SDK = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = JSON.parse(readFileSync(resolve(SDK, 'package.json'), 'utf8')) as { exports: Record<string, string> }

type Import = { specifier: string; typeOnly: boolean }
/** Every static or dynamic import and re-export of a source text, with whether the statement is `import type` / `export type`. */
function importsOf(source: string): Import[] {
  const out: Import[] = []
  for (const m of source.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g))
    out.push({ specifier: m[4], typeOnly: Boolean(m[2]) })
  for (const m of source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g))
    out.push({ specifier: m[1], typeOnly: false })
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g))
    out.push({ specifier: m[1], typeOnly: false })
  return out
}
/** The imports that make a file heavy: anything not relative and not type-only. */
const heavy = (imports: Import[]) => imports.filter((i) => !i.specifier.startsWith('.') && !i.typeOnly)

/** The files an entry reaches through relative imports (type-only included: they are part of the module graph). */
function graph(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const { specifier } of importsOf(readFileSync(file, 'utf8')))
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')))
  }
  return [...seen]
}

describe('DX694 D4 the core imports nothing heavy', () => {
  it('detects a planted heavy import and ignores relative and type-only ones', () => {
    const planted = `import x from 'openapi-typescript'\nimport type { A } from '@vibase/api'\nexport type { B } from './b.js'\nimport { c } from './c.js'\nimport { f } from 'node:fs'\nconst z = await import('typescript')\nimport 'side-effect'`
    expect(heavy(importsOf(planted)).map((i) => i.specifier)).toEqual([
      'openapi-typescript',
      'node:fs',
      'side-effect',
      'typescript',
    ])
  })

  it('analyse.ts, emit.ts and every file the ./emit entry reaches import only relative files and types', () => {
    expect(manifest.exports['./emit'], 'the workspace subpath ./emit is declared').toBeDefined()
    const entry = resolve(SDK, manifest.exports['./emit'])
    const files = graph(entry)
    const names = files.map((f) => f.replace(`${SDK}/`, ''))
    expect(names).toEqual(expect.arrayContaining(['src/generate/analyse.ts', 'src/generate/emit.ts']))
    for (const file of [...files, resolve(SDK, 'src/generate/analyse.ts'), resolve(SDK, 'src/generate/emit.ts')])
      expect(heavy(importsOf(readFileSync(file, 'utf8'))), file).toEqual([])
  })
})
