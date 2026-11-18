// The scan of the React layer ([[UI445]] D6 (a), D9): non-test sources under `src/components`, `src/lib` and the page code (the React gallery)
// may import only `react`, relative files and the allow-list below, never `preact`; `react-dom` only in a mount file; and never a `style` prop,
// a `<style>` element or `dangerouslySetInnerHTML`..
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface ReactScanViolation {
  file: string
  rule: string
  match: string
}

/** Packages the React layer may import beyond `react`; UI448 added the four D4 dependencies, pinned by decision 448.2; a later one needs its own decision. */
export const IMPORT_ALLOW_LIST: readonly string[] = [
  'react',
  'radix-ui',
  'class-variance-authority',
  'clsx',
  'tailwind-merge',
]
/** Only a page's mount file may import `react-dom` (D1, D9). */
const MOUNT_FILE = /(^|[\\/])main\.tsx?$/

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
const SPELLINGS: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'dangerouslySetInnerHTML', pattern: /\bdangerouslySetInnerHTML\b/g },
  { rule: 'style prop', pattern: /\bstyle\s*=/g },
  { rule: 'style element', pattern: /<style[\s>/]/g },
]

const isTestFile = (rel: string): boolean => /\.(test|suite)\.tsx?$/.test(rel) || /(^|[\\/])test[\\/]/.test(rel)

function* sources(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.tsx?$/.test(name)) yield path
  }
}

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const isPreact = (s: string) => s === 'preact' || s.startsWith('preact/') || s.startsWith('@preact/')
const isReactDom = (s: string) => s === 'react-dom' || s.startsWith('react-dom/')
const allowed = (s: string) =>
  s.startsWith('./') || s.startsWith('../') || IMPORT_ALLOW_LIST.some((a) => s === a || s.startsWith(`${a}/`)) // `react/jsx-runtime` is react

export function checkReactSources(dirs: readonly string[]): ReactScanViolation[] {
  const out: ReactScanViolation[] = []
  for (const root of dirs) {
    for (const file of sources(root)) {
      const rel = relative(root, file)
      if (isTestFile(rel)) continue
      const text = stripComments(readFileSync(file, 'utf-8'))
      for (const m of text.matchAll(SPECIFIER)) {
        const s = m[1]!
        if (isPreact(s)) out.push({ file: rel, rule: 'preact', match: s })
        else if (isReactDom(s)) {
          if (!MOUNT_FILE.test(rel)) out.push({ file: rel, rule: 'react-dom outside a mount file', match: s })
        } else if (!allowed(s)) out.push({ file: rel, rule: 'import outside the allow-list', match: s })
      }
      for (const { rule, pattern } of SPELLINGS) {
        for (const m of text.matchAll(pattern)) out.push({ file: rel, rule, match: m[0] })
      }
    }
  }
  return out
}
