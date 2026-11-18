// `@vibase/ui/build` ([[UI445]] D8): how a React page is built. Outside `src`, so `src` stays free of Node imports.
// A page spreads `reactBuildOptions` into its esbuild `build()` call and runs `buildStylesheet` beside it with its own source directory.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** esbuild options for a React page: automatic JSX on `react`, no alias, and production React (its entry reads `process.env.NODE_ENV`;
 *  without the define the browser throws or ships the development build, D1). Plain data: the caller passes it to `build()`. */
export const reactBuildOptions = {
  jsx: 'automatic',
  jsxImportSource: 'react',
  define: { 'process.env.NODE_ENV': '"production"' },
} as const

/** The Tailwind entry stylesheet. */
export const stylesheetEntry = fileURLToPath(new URL('../src/styles.css', import.meta.url))

export interface StylesheetOptions {
  /** Where the minified stylesheet is written (parent directories are created). */
  outFile: string
  /** Extra source directories Tailwind scans for class names, beside `src/components` (a page's own code). Absolute, or relative to the cwd. */
  sources?: readonly string[]
}

const tailwindBin = (): string => {
  const pkgPath = createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json')
  const bin = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { bin: string | Record<string, string> }).bin
  return join(dirname(pkgPath), typeof bin === 'string' ? bin : Object.values(bin)[0]!)
}

/** Compiles `styles.css` with the Tailwind CLI, minified, scanning `src/components` and every extra source directory. A missing source
 *  directory throws before the CLI runs (a typo would otherwise build a stylesheet without the page's classes); a CLI failure throws with its output. */
export async function buildStylesheet({ outFile, sources = [] }: StylesheetOptions): Promise<void> {
  const dirs = sources.map((s) => (isAbsolute(s) ? s : resolve(s)))
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      throw new Error(`buildStylesheet: source directory not found: ${dir}`)
  }
  const work = mkdtempSync(join(tmpdir(), 'vb-styles-'))
  try {
    const input = join(work, 'input.css')
    const lines = [`@import ${JSON.stringify(stylesheetEntry)};`, ...dirs.map((d) => `@source ${JSON.stringify(d)};`)]
    writeFileSync(input, `${lines.join('\n')}\n`)
    mkdirSync(dirname(resolve(outFile)), { recursive: true })
    try {
      await run(process.execPath, [tailwindBin(), '-i', input, '-o', resolve(outFile), '--minify'], { cwd: work })
    } catch (e) {
      const err = e as { stderr?: string; message: string }
      throw new Error(`buildStylesheet: the Tailwind CLI failed: ${err.stderr || err.message}`)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
