// [[UI445]] cycle 1, group 4: the React-layer source scan, with a negative fixture for each refused item.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkReactSources } from './test/react-scan'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const sandbox = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'react-scan-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('React source scan', () => {
  it('the real tree passes, and tolerates the absent src/components and src/lib', () => {
    expect(checkReactSources([join(PKG, 'src/components'), join(PKG, 'src/lib'), join(PKG, 'gallery-react')])).toEqual(
      [],
    )
  })

  it.each([
    ['preact', "import { render } from 'preact'", 'preact', 'preact'],
    ['preact/compat', "import { memo } from 'preact/compat'", 'preact', 'preact/compat'],
    ['an @preact/* package', "import { signal } from '@preact/signals'", 'preact', '@preact/signals'],
    ['an import outside the allow-list', "import _ from 'lodash'", 'import outside the allow-list', 'lodash'],
    [
      'react-dom outside a mount file',
      "import { createRoot } from 'react-dom/client'",
      'react-dom outside a mount file',
      'react-dom/client',
    ],
    ['a dynamic import of preact', "const p = await import('preact')", 'preact', 'preact'],
  ])('refuses %s', (_n, source, rule, match) => {
    const v = checkReactSources([sandbox({ 'a.tsx': source })])
    expect(v.map((x) => [x.rule, x.match])).toEqual([[rule, match]])
  })

  it.each([
    ['a style prop', 'const a = <div style={{ color: "red" }} />', 'style prop'],
    ['a <style> element', 'const a = <style>{css}</style>', 'style element'],
    ['dangerouslySetInnerHTML', 'const a = <div dangerouslySetInnerHTML={{ __html: x }} />', 'dangerouslySetInnerHTML'],
  ])('refuses %s', (_n, source, rule) => {
    expect(checkReactSources([sandbox({ 'a.tsx': source })]).map((x) => x.rule)).toEqual([rule])
  })

  it('allows react, react/jsx-runtime, relative files, className, and react-dom in a mount file', () => {
    const root = sandbox({
      'a.tsx':
        'import { useId } from \'react\'\nimport { b } from \'./b\'\nconst a = <label className="x" htmlFor="y" />',
      'main.tsx': "import { createRoot } from 'react-dom/client'",
    })
    expect(checkReactSources([root])).toEqual([])
  })

  it('exempts test files and comments', () => {
    const root = sandbox({
      'a.test.tsx': "import { render } from 'preact'",
      'b.tsx': '// never style= or dangerouslySetInnerHTML or <style>\nexport const b = 1',
    })
    expect(checkReactSources([root])).toEqual([])
  })
})
