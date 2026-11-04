import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// [[CORE69]] charter, "Import boundary". `@vault/api` production code runs in workerd: no Node built-in ([[CORE25]] D52, D53),
// and the test kit (`src/test/`, which holds `FakeChannel` and the Node stream primitives) is not reachable from the production
// barrel `src/index.ts`. The storage package's boundary test covers the enterprise imports; this one covers these two rules.
const SRC = dirname(fileURLToPath(import.meta.url))
const TEST_FILE = /\.(test|suite|typecheck)\.ts$/

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))
}
const production = (): string[] => walk(SRC).filter((f) => f.endsWith('.ts') && !TEST_FILE.test(f) && !relative(SRC, f).startsWith('test/'))
const specifiersOf = (text: string): string[] => [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)

describe('production boundary', () => {
  it('no production file imports a Node built-in', () => {
    const offenders = production().flatMap((f) => specifiersOf(readFileSync(f, 'utf8')).filter((s) => s.startsWith('node:') || ['fs', 'path', 'crypto', 'os', 'stream', 'buffer'].includes(s)).map((s) => `${relative(SRC, f)} -> ${s}`))
    expect(offenders).toEqual([])
  })

  it("`chat` is imported type-only everywhere in @vault/api/src except test files (it cannot load in workerd, D25)", () => {
    const runtimeChat = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]chat['"]|^\s*import\s+['"]chat['"]|\bimport\(\s*['"]chat['"]\s*\)/m
    const offenders = walk(SRC)
      .filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f))
      .filter((f) => runtimeChat.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('the production set includes the new pipeline files (the walk is live)', () => {
    const names = production().map((f) => relative(SRC, f))
    for (const n of ['channels/port.ts', 'messaging/streams.ts', 'messaging/preview.ts', 'messaging/store-content.ts', 'messaging/pipeline.ts', 'objects/store.ts']) expect(names).toContain(n)
  })

  it('nothing reachable from the production barrel is in the test kit (FakeChannel, node streams, fakes)', () => {
    const seen = new Set<string>()
    const queue = [join(SRC, 'index.ts')]
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const s of specifiersOf(readFileSync(file, 'utf8'))) {
        if (!s.startsWith('.')) continue
        queue.push(resolve(dirname(file), s.replace(/\.js$/, '.ts')))
      }
    }
    const reached = [...seen].map((f) => relative(SRC, f))
    expect(reached.filter((f) => f.startsWith('test/') || TEST_FILE.test(f))).toEqual([])
    expect(reached).toContain('messaging/pipeline.ts') // the barrel exports the pipeline once the cycle is green
  })
})
