import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// [[API6]] D12: no runtime dependencies, and nothing from the server packages in what ships.
const dir = fileURLToPath(new URL('.', import.meta.url))
const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
export const specifiersOf = (text: string) =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)
/** The imports the client core must never have ([[OPS231]] D12): the instance code, wrangler, the release tooling, the server packages. */
export const referencesInstanceEntry = (text: string) => /instance\.js|loadInstance/.test(text)
export const FORBIDDEN =
  /(^|\/)scripts\/instance|(^|\/)instance\.js$|(^|\/)wrangler($|\/)|^@vibase\/release|release\/src|server-d1/

/** DX694 D4: node builtins, the CLI's own files, and exactly one workspace specifier, the dependency-free generator core esbuild inlines. */
export const ALLOWED_PACKAGE = '@vibase/sdk/emit'
export const allowedSpecifier = (s: string) => s.startsWith('node:') || s.startsWith('./') || s === ALLOWED_PACKAGE

describe('what ships', () => {
  it('imports only node builtins, its own files and @vibase/sdk/emit', () => {
    expect(sources.length).toBeGreaterThan(5)
    for (const f of sources) {
      for (const s of specifiersOf(readFileSync(dir + f, 'utf8')))
        expect(allowedSpecifier(s), `${f} imports ${s}`).toBe(true)
    }
  })
  it('uses the one allowed workspace specifier (the command imports the core)', () => {
    const importers = sources.filter((f) => specifiersOf(readFileSync(dir + f, 'utf8')).includes(ALLOWED_PACKAGE))
    expect(importers).toEqual(['gen-types.ts'])
  })
  it('refuses every other @vibase/sdk specifier and the packages the bundle must not hold (absence mutation fixture)', () => {
    for (const bad of [
      '@vibase/sdk',
      '@vibase/sdk/generate',
      '@vibase/sdk/emit/extra',
      '@vibase/sdk/emit.js',
      '@vibase/api',
      'openapi-typescript',
      'typescript',
    ])
      expect(allowedSpecifier(bad), bad).toBe(false)
    for (const ok of ['node:fs', './cli.js', '@vibase/sdk/emit']) expect(allowedSpecifier(ok), ok).toBe(true)
  })
  it('declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(dir + '../package.json', 'utf8'))
    expect(pkg.dependencies).toBeUndefined()
  })
})

describe('OPS231 D12: the client core imports no server, wrangler or release code', () => {
  it('no source file (bin.ts included) imports scripts/instance, wrangler, @vibase/release, the release sources or server-d1', () => {
    for (const f of sources) {
      for (const s of specifiersOf(readFileSync(dir + f, 'utf8'))) {
        // `bin.ts` loads the sibling bundle by a computed URL, never by a static specifier that esbuild would inline.
        expect(FORBIDDEN.test(s), `${f} imports ${s}`).toBe(false)
      }
    }
  })
  it('the pattern catches each forbidden import (absence mutation fixture)', () => {
    for (const bad of [
      '../../server-d1/scripts/instance/main.js',
      '../../server-d1/scripts/instance/status.js',
      'wrangler',
      '@vibase/release',
      '../../release/src/manifest.js',
      './instance.js',
    ]) {
      expect(FORBIDDEN.test(bad), bad).toBe(true)
    }
    for (const ok of ['node:fs', './cli.js', './config.js']) expect(FORBIDDEN.test(ok), ok).toBe(false)
  })
  it('OPS240 D12: bin.ts no longer references instance.js, nor loads any sibling bundle', () => {
    const bin = readFileSync(dir + 'bin.ts', 'utf8')
    expect(referencesInstanceEntry(bin)).toBe(false)
    expect(bin).not.toMatch(/loadInstance/)
  })
  it('the bin check catches a bin.ts that references instance.js (absence mutation fixture)', () => {
    for (const bad of [
      "new URL('./instance.js', import.meta.url)",
      'await import("./instance.js")',
      'const loadInstance = async () => undefined',
    ])
      expect(referencesInstanceEntry(bad), bad).toBe(true)
    expect(referencesInstanceEntry("import { run } from './cli.js'")).toBe(false)
  })
})
