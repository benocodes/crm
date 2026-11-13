import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// [[API6]] D12: no runtime dependencies, and nothing from the server packages in what ships.
const dir = fileURLToPath(new URL('.', import.meta.url))
const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
export const specifiersOf = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)
/** The imports the client core must never have ([[OPS231]] D12): the instance code, wrangler, the release tooling, the server packages. */
export const FORBIDDEN = /(^|\/)scripts\/instance|(^|\/)instance\.js$|(^|\/)wrangler($|\/)|^@vault\/release|release\/src|server-d1/

describe('what ships', () => {
  it('imports only node builtins and its own files', () => {
    expect(sources.length).toBeGreaterThan(5)
    for (const f of sources) {
      for (const s of specifiersOf(readFileSync(dir + f, 'utf8'))) expect(s.startsWith('node:') || s.startsWith('./'), `${f} imports ${s}`).toBe(true)
    }
  })
  it('declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(dir + '../package.json', 'utf8'))
    expect(pkg.dependencies).toBeUndefined()
  })
})

describe('OPS231 D12: the client core imports no server, wrangler or release code', () => {
  it('no source file (bin.ts included) imports scripts/instance, wrangler, @vault/release, the release sources or server-d1', () => {
    for (const f of sources) {
      for (const s of specifiersOf(readFileSync(dir + f, 'utf8'))) {
        // `bin.ts` loads the sibling bundle by a computed URL, never by a static specifier that esbuild would inline.
        expect(FORBIDDEN.test(s), `${f} imports ${s}`).toBe(false)
      }
    }
  })
  it('the pattern catches each forbidden import (absence mutation fixture)', () => {
    for (const bad of ['../../server-d1/scripts/instance/main.js', '../../server-d1/scripts/instance/status.js', 'wrangler', '@vault/release', '../../release/src/manifest.js', './instance.js']) {
      expect(FORBIDDEN.test(bad), bad).toBe(true)
    }
    for (const ok of ['node:fs', './cli.js', './config.js']) expect(FORBIDDEN.test(ok), ok).toBe(false)
  })
  it('the sources reference the sibling bundle only as a file name beside the running file', () => {
    expect(readFileSync(dir + 'bin.ts', 'utf8')).toMatch(/instance\.js/)
  })
})
