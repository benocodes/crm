// [[UI446]] D2 (group 3): the React-layer scan (packages/ui's `react-scan.ts`, reused, not copied) over the auth pages' tree, with this tree's own allow-list entries.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkReactSources } from '../../ui/src/test/react-scan'

const UI_TREE = fileURLToPath(new URL('./ui', import.meta.url))
/** This tree's allow-list entries beyond the scan's own: the component set (never the root `@vibase/ui`, the Preact layer) and the dependency-free scope catalogue leaf ([[UI247]] D5). */
const PAGE_ALLOW = ['@vibase/ui/components', '@vibase/api/scope-descriptions'] as const

const sandbox = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'ui-scan-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}
const scan = (files: Record<string, string>) => checkReactSources([sandbox(files)], { allow: PAGE_ALLOW })

describe('the auth pages tree against the React scan', () => {
  it('src/ui has no violation: components only from @vibase/ui/components, no preact, react-dom only in main.tsx, no style prop, <style> or dangerouslySetInnerHTML', () => {
    expect(checkReactSources([UI_TREE], { allow: PAGE_ALLOW })).toEqual([])
  })

  it('the tree is non-empty (the scan reads the page sources)', () => {
    expect(checkReactSources([UI_TREE]).length).toBeGreaterThan(0) // without the extra entries the component imports are refused
  })

  it.each([
    ['a preact import', "import { render } from 'preact'", 'preact', 'preact'],
    [
      'the @vibase/ui root import (the Preact layer)',
      "import { Button } from '@vibase/ui'",
      'import outside the allow-list',
      '@vibase/ui',
    ],
    [
      'react-dom outside main.tsx',
      "import { createRoot } from 'react-dom/client'",
      'react-dom outside a mount file',
      'react-dom/client',
    ],
  ])('refuses %s', (_n, source, rule, match) => {
    expect(scan({ 'page.tsx': source }).map((v) => [v.rule, v.match])).toEqual([[rule, match]])
  })

  it.each([
    ['a style prop', 'export const a = <div style={{ color: "red" }} />', 'style prop'],
    ['a <style> element', 'export const a = <style>{css}</style>', 'style element'],
    [
      'dangerouslySetInnerHTML',
      'export const a = <div dangerouslySetInnerHTML={{ __html: x }} />',
      'dangerouslySetInnerHTML',
    ],
  ])('refuses %s', (_n, source, rule) => {
    expect(scan({ 'page.tsx': source }).map((v) => v.rule)).toEqual([rule])
  })

  it('accepts @vibase/ui/components and, in main.tsx, react-dom/client', () => {
    expect(
      scan({
        'page.tsx': "import { Button } from '@vibase/ui/components'",
        'main.tsx': "import { createRoot } from 'react-dom/client'",
      }),
    ).toEqual([])
  })
})
