// Group 2 ([[UI254]] D2, D3b): the subset scan, with a negative case for each refused item.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkSubset } from './test/subset'

const SRC = fileURLToPath(new URL('.', import.meta.url))

const sandbox = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'subset-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('subset scan', () => {
  it('the real packages/ui/src passes', () => {
    expect(checkSubset(SRC)).toEqual([])
  })

  it.each([
    ['an import other than react', "import { x } from 'lodash'", 'lodash'],
    ['preact', "import { render } from 'preact'", 'preact'],
    ['preact/hooks', "import { useState } from 'preact/hooks'", 'preact/hooks'],
    ['preact/compat', "import { memo } from 'preact/compat'", 'preact/compat'],
    ['an @preact/* package', "import { signal } from '@preact/signals'", '@preact/signals'],
    ['react-dom', "import { createPortal } from 'react-dom'", 'react-dom'],
    ['react-dom/client', "import { createRoot } from 'react-dom/client'", 'react-dom/client'],
    ['a dynamic import of preact', "const p = await import('preact')", 'preact'],
  ])('refuses %s', (_name, source, specifier) => {
    const v = checkSubset(sandbox({ 'a.tsx': source }))
    expect(v.map((x) => [x.rule, x.match])).toEqual([['import', specifier]])
  })

  it.each([
    ['dangerouslySetInnerHTML', 'const a = <div dangerouslySetInnerHTML={{ __html: x }} />', 'dangerouslySetInnerHTML'],
    ['a style prop', 'const a = <div style={{ color: "red" }} />', 'style prop'],
    ['a class attribute', 'const a = <div class="x" />', 'class attribute (use className)'],
    ['forwardRef', "const A = forwardRef(() => null)", 'forwardRef (ref is an ordinary prop)'],
  ])('refuses %s', (_name, source, rule) => {
    expect(checkSubset(sandbox({ 'a.tsx': source })).map((x) => x.rule)).toEqual([rule])
  })

  it('allows react, relative files and the stylesheet, and className/htmlFor', () => {
    const root = sandbox({
      'a.tsx': "import { useId } from 'react'\nimport type { ReactNode } from 'react'\nimport { b } from './b'\nimport '../ui.css'\nconst a = <label className=\"x\" htmlFor=\"y\" />",
    })
    expect(checkSubset(root)).toEqual([])
  })

  it('exempts test files and src/test/, which may import anything', () => {
    const root = sandbox({
      'a.test.tsx': "import { render } from 'preact'\nconst a = <div class=\"x\" />",
      'a.ui.test.tsx': "import { x } from '@testing-library/react'",
      'test/helper.ts': "import { x } from 'preact'",
    })
    expect(checkSubset(root)).toEqual([])
  })

  it('does not trip on a comment that names a refused spelling', () => {
    expect(checkSubset(sandbox({ 'a.tsx': "// never dangerouslySetInnerHTML, style= or class=\n/* forwardRef */\nexport const a = 1" }))).toEqual([])
  })
})
