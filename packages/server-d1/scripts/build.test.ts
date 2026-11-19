import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { buildApp } from './build-app.js'
import { buildUi } from './build-ui.js'

// [[UI476]] D10 (group 2, build half): the Preact /connect page is gone from the build; the package's `pnpm build` makes the auth pages and the app and nothing else, into the directory `wrangler.jsonc` names.
// Carried from the deleted build-connect.test.ts ([[UI30]] D3): the asset directory is the one wrangler names and git ignores, dev builds first, nothing of the E2E harness is a dependency or reaches the source.
const PKG = fileURLToPath(new URL('..', import.meta.url))
const ASSETS_DIR = join(PKG, 'dist', 'assets')
let out: string
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'pages-build-'))
  await buildUi(out)
  await buildApp(out)
})
afterAll(() => rmSync(out, { recursive: true, force: true }))

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
const pkgJson = () =>
  JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

describe('nothing builds the connect page (UI476 D10)', () => {
  it('the build output has the ui/ and app/ directories and no connect/', () => {
    expect(readdirSync(out).sort()).toEqual(['app', 'ui'])
    expect(walk(out).filter((f) => /\/connect[/.]/.test(f.slice(out.length)))).toEqual([])
  })

  it('the build script builds the auth pages and the app, and removes a stale connect/ left by an earlier build', () => {
    const build = pkgJson().scripts.build!
    expect(build).not.toContain('build-connect')
    expect(build).toContain('build-ui')
    expect(build).toContain('build-app')
    expect(build).toMatch(/rm -rf dist\/assets\/connect/)
  })

  it('the page, its build script, its serving module and its browser E2E are deleted', () => {
    for (const f of [
      'src/connect',
      'scripts/build-connect.ts',
      'scripts/build-connect.test.ts',
      'src/connect-serving.ts',
      'src/connect-serving.test.ts',
      'src/connect-csp-providers.test.ts',
      'e2e/connect.e2e.ts',
    ])
      expect(existsSync(join(PKG, f)), f).toBe(false)
    expect(pkgJson().scripts['e2e:connect']).toBeUndefined()
  })
})

describe('the asset directory and the test dependencies', () => {
  it('no non-test file under src/ names @clerk/testing or @playwright', () => {
    for (const f of walk(join(PKG, 'src')).filter((x) => /\.tsx?$/.test(x) && !/\.test\.tsx?$/.test(x)))
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/@clerk\/testing|@playwright|playwright/i)
  })

  it('the default output is the directory wrangler.jsonc names, and it is ignored by git', () => {
    const cfg = unstable_readConfig({ config: join(PKG, 'wrangler.jsonc') })
    expect(resolve(dirname(join(PKG, 'wrangler.jsonc')), cfg.assets!.directory!)).toBe(ASSETS_DIR)
    expect(readFileSync(join(PKG, '../../.gitignore'), 'utf8')).toMatch(/^dist\/$/m)
  })

  it('dev builds first, and smoke:worker builds the pages it serves', () => {
    expect(pkgJson().scripts.dev).toMatch(/^pnpm build && /)
    const smoke = readFileSync(join(PKG, 'scripts/smoke-worker.ts'), 'utf8')
    expect(smoke).toContain('buildUi(')
    expect(smoke).toContain('buildApp(')
    expect(smoke).not.toContain('buildConnect')
  })

  it('the E2E tools are devDependencies only', () => {
    const pkg = pkgJson()
    for (const d of ['@playwright/test', '@clerk/testing', 'happy-dom']) {
      expect(pkg.devDependencies[d], d).toBeTruthy()
      expect(pkg.dependencies[d], d).toBeUndefined()
    }
  })
})
