import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// [[UI461]] D3 (group 2): after sign-in or acceptance the pages go to /home. No source under src/ui may default to '/connect' (the allow-list in continuation.ts names it as a return target, which is a different thing).
describe("no '/connect' default remains in the auth pages", () => {
  const files = readdirSync(new URL('.', import.meta.url)).filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'continuation.ts',
  )
  it.each(files)('%s', (f) => {
    expect(readFileSync(new URL(f, import.meta.url), 'utf8')).not.toMatch(/['"`]\/connect['"`]/)
  })
})

// [[UI476]] D10, 476.6 (group 2, source half): the Preact /connect page is deleted and `/connect` is a redirect, so no source under server-d1 `src` and `scripts`, or the release package, names `/connect` as a path outside the allow-list:
// the redirect and its test, the `return_to` allow-list (`continuation.ts`) and its tests, and the `run_worker_first` lists with their pins.
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const ROOTS = [
  'packages/server-d1/src',
  'packages/server-d1/scripts',
  'packages/release/src',
  'packages/release/scripts',
]
const ALLOWED = new Set([
  'packages/server-d1/src/app-serving.ts',
  'packages/server-d1/src/app-serving.test.ts',
  'packages/server-d1/src/ui/continuation.ts',
  'packages/server-d1/src/ui/continuation.test.ts',
  'packages/server-d1/src/ui/sign-in-page.ui.test.tsx',
  'packages/server-d1/src/ui/sign-in-return.ui.test.tsx',
  'packages/server-d1/src/ui/no-connect-default.test.ts',
  'packages/server-d1/src/wrangler-config.test.ts',
  'packages/server-d1/scripts/smoke-worker.ts',
  'packages/server-d1/scripts/setup/test/wrangler.fixture.jsonc',
  'packages/release/src/fixtures.ts',
  'packages/release/scripts/check.ts',
])
/** `/connect` as a whole path segment: not `/connections`, `/connect-return`, `/oauth/connect`, a file name, or the start of a regex literal or an escaped slash (`(/connect an agent/`, `\/connect`). */
const CONNECT_PATH = /(?<![\w/.\-(\\])\/connect(?![\w-])/
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
const sources = ROOTS.flatMap((r) => walk(join(REPO, r)))
  .filter((f) => /\.(tsx?|jsonc?|css|html)$/.test(f) && !f.includes('node_modules'))
  .map((f) => relative(REPO, f))

describe("no source names '/connect' as a path outside the allow-list (UI476)", () => {
  it('the scan sees the packages it is about', () => {
    expect(sources.length).toBeGreaterThan(100)
    expect(sources).toContain('packages/server-d1/src/app-serving.ts')
  })
  it('every other file is free of it', () => {
    const hits = sources.filter((f) => !ALLOWED.has(f) && CONNECT_PATH.test(readFileSync(join(REPO, f), 'utf8')))
    expect(hits).toEqual([])
  })
  it('the allow-list has no stale entry: each file names /connect', () => {
    for (const f of ALLOWED) expect(CONNECT_PATH.test(readFileSync(join(REPO, f), 'utf8')), f).toBe(true)
  })
})
