import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

// DX603 D1: the runtime entry imports nothing from node:* or @vibase/*, and bundles for a browser and for workerd.
const SRC = dirname(fileURLToPath(import.meta.url))

const specifiers = (source: string): string[] =>
  [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])

export const forbidden = (specifier: string) => specifier.startsWith('node:') || specifier.startsWith('@vibase/')

/** The files the runtime entry reaches through relative imports (types included: they ship in the same module graph). */
function runtimeFiles(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')))
    }
  }
  return [...seen]
}

describe('DX603 D1 runtime boundary', () => {
  it('flags node: and @vibase/ specifiers and nothing else (a planted import is caught)', () => {
    const planted = `import { x } from 'node:fs'\nimport type { y } from '@vibase/api'\nimport { z } from './errors.js'\nconst w = await import('node:path')`
    expect(specifiers(planted).filter(forbidden)).toEqual(['node:fs', '@vibase/api', 'node:path'])
  })

  it('no file the runtime entry reaches imports node:* or @vibase/*, and none is under generate/', () => {
    const files = runtimeFiles(join(SRC, 'index.ts'))
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) {
      expect(file, 'the runtime reaches the generator').not.toContain(`${join(SRC, 'generate')}/`)
      expect(specifiers(readFileSync(file, 'utf8')).filter(forbidden), file).toEqual([])
    }
  })

  it('the generator and the drift test are the only files that import @vibase/api', () => {
    const importers: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name !== 'boundary.test.ts' && /\.tsx?$/.test(entry.name) && specifiers(readFileSync(path, 'utf8')).some((s) => s === '@vibase/api'))
          importers.push(path.slice(SRC.length + 1))
      }
    }
    walk(SRC)
    for (const file of importers) expect(file.startsWith('generate/'), file).toBe(true)
  })

  it('the entry bundles for the browser with the workerd, worker and browser conditions', async () => {
    const result = await build({
      entryPoints: [join(SRC, 'index.ts')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      conditions: ['workerd', 'worker', 'browser'],
      logLevel: 'silent',
    })
    expect(result.errors).toEqual([])
    const text = result.outputFiles[0].text
    expect(text).toContain('createClient')
    expect(text).not.toContain('openapi-typescript')
    expect(text).not.toMatch(/node:/)
  })
})
