import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// [[API6]] D12: no runtime dependencies, and nothing from the server packages in what ships.
describe('what ships', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  it('imports only node builtins and its own files', () => {
    expect(sources.length).toBeGreaterThan(5)
    for (const f of sources) {
      const specifiers = [...readFileSync(dir + f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)
      for (const s of specifiers) expect(s.startsWith('node:') || s.startsWith('./'), `${f} imports ${s}`).toBe(true)
    }
  })
  it('declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(dir + '../package.json', 'utf8'))
    expect(pkg.dependencies).toBeUndefined()
  })
})
