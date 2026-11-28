// [[OPS693]] D1: `buildSdk` emits exactly the runtime closure of `src/index.ts` into `<outDir>/dist/` and writes nothing into `packages/sdk`.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listFiles } from './manifest.js'
import { buildSdk } from './sdk-build.js'

const SDK = fileURLToPath(new URL('../../sdk/', import.meta.url))
const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    if (e.isDirectory()) out.push(...walk(join(dir, e.name)).map((f) => `${e.name}/${f}`))
    else out.push(e.name)
  }
  return out.sort()
}

let outDir: string
let files: string[]
let before: string[]
beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'ops693-build-'))
  before = walk(SDK)
  await buildSdk({ outDir })
  files = listFiles(outDir).sort()
}, 120_000)
afterAll(() => rmSync(outDir, { recursive: true, force: true }))

describe('buildSdk (D1)', () => {
  it('emits dist/index.js and dist/index.d.ts, and only under dist/', () => {
    expect(files).toContain('dist/index.js')
    expect(files).toContain('dist/index.d.ts')
    expect(files.filter((f) => !f.startsWith('dist/'))).toEqual([])
  })
  it('emits a .d.ts for every .js and a .js for every .d.ts', () => {
    const js = files.filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3))
    const dts = files.filter((f) => f.endsWith('.d.ts')).map((f) => f.slice(0, -5))
    expect(js.length).toBeGreaterThan(3)
    expect(js.sort()).toEqual(dts.sort())
  })
  it('emits nothing from generate/, testing, tests or typecheck files, and no source maps', () => {
    expect(files.filter((f) => /\/generate\/|testing|\.test\.|typecheck|\.map$/.test(f))).toEqual([])
    expect(files.every((f) => f.endsWith('.js') || f.endsWith('.d.ts'))).toBe(true)
  })
  it('writes nothing new under packages/sdk', () => {
    expect(walk(SDK)).toEqual(before)
  })
  it('the emitted index.js imports under Node and exports createClient, VibaseError and isVibaseError', async () => {
    writeFileSync(join(outDir, 'package.json'), '{"type":"module"}')
    const m = await import(pathToFileURL(join(outDir, 'dist', 'index.js')).href)
    expect(typeof m.createClient).toBe('function')
    expect(typeof m.VibaseError).toBe('function')
    expect(typeof m.isVibaseError).toBe('function')
  })
})
