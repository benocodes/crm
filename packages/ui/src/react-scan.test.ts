// [[UI445]] cycle 1, group 4: the React-layer source scan, with a negative fixture for each refused item.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkReactSources, IMPORT_ALLOW_LIST } from './test/react-scan'

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
  it('the real tree passes: src/components, src/lib and the gallery import only what D4 allows', () => {
    expect(checkReactSources([join(PKG, 'src/components'), join(PKG, 'src/lib'), join(PKG, 'gallery-react')])).toEqual(
      [],
    )
  })

  it('the allow-list is react, the four D4 packages (448.2) and lucide-react (UI443 P3)', () => {
    expect([...IMPORT_ALLOW_LIST].sort()).toEqual(
      ['class-variance-authority', 'clsx', 'lucide-react', 'radix-ui', 'react', 'tailwind-merge'].sort(),
    )
  })

  it.each(['radix-ui', 'class-variance-authority', 'clsx', 'tailwind-merge', 'lucide-react'])('accepts %s', (pkg) => {
    expect(checkReactSources([sandbox({ 'a.tsx': `import x from '${pkg}'` })])).toEqual([])
  })

  it('accepts a subpath of an allowed package (radix-ui/internal)', () => {
    expect(checkReactSources([sandbox({ 'a.tsx': "import x from 'radix-ui/internal'" })])).toEqual([])
  })

  it.each([
    ['a lookalike of lucide-react (lucide-react-native)', "import x from 'lucide-react-native'", 'lucide-react-native'],
    ['a scoped radix package', "import { Slot } from '@radix-ui/react-slot'", '@radix-ui/react-slot'],
    ['a prefix lookalike of an allowed package', "import x from 'clsx-extra'", 'clsx-extra'],
    ['an @/ alias import', "import { cn } from '@/lib/utils'", '@/lib/utils'],
  ])('refuses %s', (_n, source, match) => {
    const v = checkReactSources([sandbox({ 'a.tsx': source })])
    expect(v.map((x) => [x.rule, x.match])).toEqual([['import outside the allow-list', match]])
  })

  it('the old Preact subset scan is gone, and nothing references it (ruling 448.1)', () => {
    expect(existsSync(join(PKG, 'src/test/subset.ts'))).toBe(false)
    expect(existsSync(join(PKG, 'src/subset.test.ts'))).toBe(false)
    const name = ['check', 'Subset'].join('')
    const hits = spawnSync('git', ['grep', '-n', name], { cwd: PKG, encoding: 'utf-8' }).stdout.split('\n')
    expect(hits.filter((l) => l && !l.includes('react-scan.test.ts'))).toEqual([])
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

  it('a tree may extend the allow-list for itself only (UI446 D2): exact or a subpath, never a prefix lookalike', () => {
    const root = sandbox({
      'a.tsx': "import { A } from '@vibase/ui/components'\nimport { B } from '@vibase/ui/components/ui'",
    })
    expect(checkReactSources([root], { allow: ['@vibase/ui/components'] })).toEqual([])
    expect(checkReactSources([root]).map((x) => x.match)).toEqual(['@vibase/ui/components', '@vibase/ui/components/ui'])
    const lookalike = sandbox({ 'a.tsx': "import { A } from '@vibase/ui/components-extra'" })
    expect(checkReactSources([lookalike], { allow: ['@vibase/ui/components'] }).map((x) => x.match)).toEqual([
      '@vibase/ui/components-extra',
    ])
  })

  it('exempts test files and comments', () => {
    const root = sandbox({
      'a.test.tsx': "import { render } from 'preact'",
      'b.tsx': '// never style= or dangerouslySetInnerHTML or <style>\nexport const b = 1',
    })
    expect(checkReactSources([root])).toEqual([])
  })
})
