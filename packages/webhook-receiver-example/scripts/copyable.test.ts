import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// "Copyable" (API221): the example's own sources import no workspace package, no path outside src and no runtime dependency, so a customer copies `src/` and `wrangler.jsonc` and nothing else.
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(pkg, 'src')
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]))
const importsOf = (text: string) => [...text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g)].map((m) => (m[1] ?? m[2] ?? m[3])!)

/** The imports that would break a copy; a node: builtin and `cloudflare:` module are the platform. */
export function foreignImports(file: string, text: string, root = src): string[] {
  return importsOf(text).filter((spec) => {
    if (spec.startsWith('node:') || spec.startsWith('cloudflare:')) return false
    if (spec.startsWith('.')) return relative(root, resolve(dirname(file), spec)).startsWith('..')
    return true
  })
}

describe('the example is copyable', () => {
  const sources = files(src).filter((f) => f.endsWith('.ts'))
  it('has sources', () => expect(sources.length).toBeGreaterThan(3))
  it('imports nothing from @vault/*, outside src/, or any npm package', () => {
    for (const f of sources) expect(foreignImports(f, readFileSync(f, 'utf8')), relative(pkg, f)).toEqual([])
  })
  it('the detector sees a workspace import, a path outside src and a bare package', () => {
    const f = join(src, 'x.ts')
    expect(foreignImports(f, `import { a } from '@vault/api'`)).toEqual(['@vault/api'])
    expect(foreignImports(f, `import { a } from '../scripts/x.js'`)).toEqual(['../scripts/x.js'])
    expect(foreignImports(f, `import x from 'hono'; import { y } from './y.js'; import z from 'node:fs'`)).toEqual(['hono'])
  })
  it('declares no runtime dependency', () => {
    const json = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
    expect(json.dependencies ?? {}).toEqual({})
  })
})

describe('the Worker config matches the entry', () => {
  const config = readFileSync(join(pkg, 'wrangler.jsonc'), 'utf8')
  const parsed = JSON.parse(config.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))
  it('has one Workflow binding, no routes and no account id', () => {
    expect(parsed.workflows).toHaveLength(1)
    expect(parsed.workers_dev).toBe(false)
    expect(parsed.routes).toBeUndefined()
    expect(parsed.account_id).toBeUndefined()
  })
  it('exports the class the binding names, from the entry, as a Workflow', () => {
    const entry = readFileSync(join(src, parsed.main.replace(/^src\//, '')), 'utf8')
    const cls = parsed.workflows[0].class_name as string
    const exported = new RegExp(`export\\s*\\{[^}]*\\b${cls}\\b[^}]*\\}|export\\s+class\\s+${cls}\\b`).test(entry)
    expect(exported, `entry exports ${cls}`).toBe(true)
    const defining = files(src).map((f) => readFileSync(f, 'utf8')).find((t) => new RegExp(`class\\s+${cls}\\s+extends\\s+WorkflowEntrypoint`).test(t))
    expect(defining).toBeDefined()
    expect(parsed.workflows[0].binding).toMatch(/^[A-Z_]+$/)
  })
  it('ships the template, the readme and no secret', () => {
    expect(existsSync(join(pkg, '.dev.vars.example'))).toBe(true)
    expect(existsSync(join(pkg, 'README.md'))).toBe(true)
    expect(existsSync(join(pkg, '.dev.vars'))).toBe(false)
    expect(readFileSync(join(pkg, '.dev.vars.example'), 'utf8')).not.toMatch(/whsec_[A-Za-z0-9+/=]{20,}|vk_[A-Za-z0-9_-]{20,}/)
  })
})
