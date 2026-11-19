// [[UI445]] cycle 1, groups 1 to 3: the build helper ships production React and the caller's classes, and the theme's dark-mode semantics.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, type BuildOptions } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { buildStylesheet, reactBuildOptions } from '../build/index'
import { PAGE_CSP } from '../src/csp'
import { packagesIn } from './build-gallery-react'

const tmp = () => mkdtempSync(join(tmpdir(), 'react-build-'))
const write = (dir: string, files: Record<string, string>) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

async function bundle(options: BuildOptions) {
  const result = await build({
    ...options,
    stdin: {
      contents:
        "import { createRoot } from 'react-dom/client'\ncreateRoot(document.body).render(<p className='x'>hi</p>)\n",
      resolveDir: join(import.meta.dirname, '..'),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    // Unminified on purpose: esbuild defaults NODE_ENV to production only when minifying, so only here does the define decide.
    minify: false,
    metafile: true,
    logLevel: 'silent',
  })
  return result.metafile
}

describe('PAGE_CSP (group 1)', () => {
  it('is the pages’ strict policy: self-only scripts and styles, no unsafe-inline', () => {
    expect(PAGE_CSP).toContain("script-src 'self'")
    expect(PAGE_CSP).toContain("style-src 'self'")
    expect(PAGE_CSP).not.toContain('unsafe-inline')
  })
})

describe('the React build options (group 2)', () => {
  it('bundle production react-dom and no preact, and no development build', async () => {
    const metafile = await bundle(reactBuildOptions as unknown as BuildOptions)
    const inputs = Object.keys(metafile.inputs)
    expect(packagesIn(metafile)).toEqual(expect.arrayContaining(['react', 'react-dom']))
    expect(packagesIn(metafile)).not.toContain('preact')
    expect(inputs.some((i) => /react-dom.*\.production\.js$/.test(i))).toBe(true)
    expect(inputs.filter((i) => /\.development\.js$/.test(i))).toEqual([])
  })

  it('has teeth: without the NODE_ENV define the development build is bundled', async () => {
    const { define: _dropped, ...rest } = reactBuildOptions
    const metafile = await bundle(rest as unknown as BuildOptions)
    expect(Object.keys(metafile.inputs).some((i) => /\.development\.js$/.test(i))).toBe(true)
  })
})

describe('the stylesheet step (group 2)', () => {
  it('writes a minified file with a rule for a class used only in the extra source directory, and none for an unused class', async () => {
    const src = write(tmp(), { 'page.tsx': 'export const a = <p className="bg-pink-500 underline-offset-8" />' })
    const out = join(tmp(), 'nested', 'page.css')
    await buildStylesheet({ outFile: out, sources: [src] })
    const css = readFileSync(out, 'utf-8')
    expect(css).toContain('.bg-pink-500{')
    expect(css).toContain('.underline-offset-8{')
    expect(css).not.toContain('.bg-yellow-500{') // used nowhere
    expect(css.split('\n').length).toBeLessThanOrEqual(2) // minified
  })

  it('has teeth: without the extra source argument the caller’s class has no rule', async () => {
    const out = join(tmp(), 'page.css')
    await buildStylesheet({ outFile: out })
    expect(readFileSync(out, 'utf-8')).not.toContain('.underline-offset-8{')
  })

  it('refuses a missing extra source directory before running the CLI, writing nothing', async () => {
    const out = join(tmp(), 'page.css')
    await expect(buildStylesheet({ outFile: out, sources: [join(tmp(), 'nope')] })).rejects.toThrow(
      /source directory not found/,
    )
    expect(existsSync(out)).toBe(false)
  })
})

describe('theme and dark mode (group 3)', () => {
  const compile = async () => {
    const src = write(tmp(), { 'p.tsx': 'export const a = <p className="dark:text-destructive bg-background" />' })
    const out = join(tmp(), 'theme.css')
    await buildStylesheet({ outFile: out, sources: [src] })
    return readFileSync(out, 'utf-8')
  }

  it('defines the tokens for light, for the OS dark preference and for data-theme="dark"', async () => {
    const css = await compile()
    for (const token of [
      '--background',
      '--foreground',
      '--primary',
      '--destructive',
      '--border',
      '--ring',
      '--radius',
    ]) {
      expect(css, token).toContain(`${token}:`)
    }
    expect(css).toMatch(/:root\{[^}]*--background:#fff/)
    expect(css).toMatch(
      /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{[^}]*--background:#0a0a0a/,
    )
    expect(css).toMatch(/:root\[data-theme=dark\]\{[^}]*--background:#0a0a0a/)
  })

  it('a dark: utility applies under the media query unless data-theme="light", and always under data-theme="dark"', async () => {
    const css = await compile()
    expect(css).toMatch(
      /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\) \.dark\\:text-destructive\{color:var\(--destructive\)\}/,
    )
    expect(css).toMatch(/:root\[data-theme=dark\] \.dark\\:text-destructive\{color:var\(--destructive\)\}/)
  })

  it('maps tokens into utilities', async () => {
    expect(await compile()).toContain('.bg-background{background-color:var(--background)}')
  })
})
