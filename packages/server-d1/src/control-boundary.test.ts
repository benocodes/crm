import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { d1Binding, openControlDb, type D1Like } from '@vibase/storage-d1'
import type { D1Binding } from '@vibase/storage'

// [[CORE259]] D5: CONTROL_DB (and the control store) is reachable from composition and the control store only. The operation storage binding wraps DB only.
const PACKAGES = fileURLToPath(new URL('../../', import.meta.url))

/** Where the identifier may appear: the composition (Worker, bootstrap, their scripts) and the control store itself (and its package index, which re-exports it). */
export const ALLOWED = [/^server-d1\/src\/compose\.ts$/, /^server-d1\/src\/bootstrap-d1\.ts$/, /^server-d1\/scripts\//, /^storage-d1\/src\/control-store\.ts$/, /^storage-d1\/src\/index\.ts$/]
const REACH = /\bCONTROL_DB\b|\bopenControlDb\b|\bControlDb\b|\bcontrolAuthDatabase\b|control-store/

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.wrangler') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.ts$/.test(name) && !/\.(test|suite|typecheck)\.ts$/.test(name) && !/[\\/]test[\\/]/.test(path)) yield path
  }
}

/** Every production source outside the allowed places that names the control binding or its store. */
export function controlReachViolations(root: string): string[] {
  const out: string[] = []
  for (const pkg of readdirSync(root)) {
    const dir = join(root, pkg)
    if (!statSync(dir).isDirectory()) continue
    for (const sub of ['src', 'scripts']) {
      let files: string[] = []
      try {
        files = [...sources(join(dir, sub))]
      } catch {
        continue
      }
      for (const file of files) {
        const rel = relative(root, file).split('\\').join('/')
        if (ALLOWED.some((a) => a.test(rel))) continue
        if (REACH.test(readFileSync(file, 'utf8'))) out.push(rel)
      }
    }
  }
  return out
}

describe('the control binding boundary (D5)', () => {
  it('the repository: no operation, storage, API or other production module names CONTROL_DB or the control store', () => {
    expect(controlReachViolations(PACKAGES)).toEqual([])
  })

  it('the check sees a violation (an operation module reaching the binding is reported)', () => {
    const root = mkdtempSync(join(tmpdir(), 'control-boundary-'))
    mkdirSync(join(root, 'api/src/contacts'), { recursive: true })
    writeFileSync(join(root, 'api/src/contacts/list.ts'), 'export const x = (env: { CONTROL_DB: unknown }) => env.CONTROL_DB')
    mkdirSync(join(root, 'api/src/other'), { recursive: true })
    writeFileSync(join(root, 'api/src/other/y.ts'), "import { openControlDb } from '@vibase/storage-d1'")
    expect(controlReachViolations(root).sort()).toEqual(['api/src/contacts/list.ts', 'api/src/other/y.ts'])
  })

  it('the identifier does appear in composition, so the allow-list is not vacuous', () => {
    expect(readFileSync(join(PACKAGES, 'server-d1/src/compose.ts'), 'utf8')).toMatch(/\bCONTROL_DB\b/)
  })
})

describe('the operation storage binding cannot carry the control binding (D5, type level)', () => {
  const link = { organizationId: '0190b2c4-0000-7000-8000-00000000a001', authProvider: 'none', authOrgId: 'org_x' }
  it('d1Binding refuses a control database and a D1Binding cannot hold one as its runtime', () => {
    const raw = { prepare: () => undefined, batch: () => undefined } as unknown as D1Like
    const control = openControlDb(raw)
    // @ts-expect-error the storage runtime wraps a D1Like, which the opaque control handle is not
    const wrapped: D1Binding = d1Binding(control, link)
    // @ts-expect-error a D1Binding's runtime is not the control handle
    const carried: D1Binding['runtime'] = control
    // And the plain database still wraps (so the expectations above fail for the reason named, not for a broken signature).
    const ok: D1Binding = d1Binding(raw, link)
    expect([ok.kind, typeof wrapped, typeof carried]).toBeDefined()
  })
})
