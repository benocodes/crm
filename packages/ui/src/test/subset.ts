// The common-subset scan ([[UI254]] D2, D3b). `@vibase/ui`'s non-test sources may be rendered by Preact and by React, so they use only what both
// implement the same way. A scan cannot see everything D2 excludes (portals, Suspense, ...), so it refuses what it can: imports other than
// `react`, relative files and the stylesheet, and the spellings `class=`, `style=`, `dangerouslySetInnerHTML` and `forwardRef`.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface SubsetViolation {
  file: string
  rule: string
  /** The offending import specifier or spelling. */
  match: string
}

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
const SPELLINGS: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'dangerouslySetInnerHTML', pattern: /\bdangerouslySetInnerHTML\b/g },
  { rule: 'style prop', pattern: /\bstyle\s*=/g },
  { rule: 'class attribute (use className)', pattern: /\bclass\s*=/g },
  { rule: 'forwardRef (ref is an ordinary prop)', pattern: /\bforwardRef\b/g },
]

const isTestFile = (rel: string): boolean => /\.(test|suite)\.tsx?$/.test(rel) || /(^|[\\/])test[\\/]/.test(rel)

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.tsx?$/.test(name)) yield path
  }
}

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

/** An import is allowed when it is `react`, a relative path (a sibling source or the stylesheet). */
const allowedImport = (specifier: string): boolean => specifier === 'react' || specifier.startsWith('./') || specifier.startsWith('../')

/** Scans the non-test `.ts`/`.tsx` files under `srcDir` and returns every violation of the subset. */
export function checkSubset(srcDir: string): SubsetViolation[] {
  const out: SubsetViolation[] = []
  for (const file of sources(srcDir)) {
    const rel = relative(srcDir, file)
    if (isTestFile(rel)) continue
    const text = stripComments(readFileSync(file, 'utf-8'))
    for (const m of text.matchAll(SPECIFIER)) {
      if (!allowedImport(m[1]!)) out.push({ file: rel, rule: 'import', match: m[1]! })
    }
    for (const { rule, pattern } of SPELLINGS) {
      for (const m of text.matchAll(pattern)) out.push({ file: rel, rule, match: m[0] })
    }
  }
  return out
}
