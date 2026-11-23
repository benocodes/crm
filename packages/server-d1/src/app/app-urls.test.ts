import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startGoogleSignIn } from '../ui/auth-api.js'
import { NAV } from './nav.js'
import { APP_PAGE_PATHS } from './paths.js'

// [[UI507]] D7, P1 (group 4): every URL that names an app page names an entry of the page table.
const SRC = fileURLToPath(new URL('..', import.meta.url))
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /\.test\.ts$/.test(f) || f.includes('/test/')
const sources = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !isTest(f))
/** Code lines only: a line that is whole-line comment is dropped and a trailing `// ...` comment is cut. */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .map((l) => l.replace(/\s\/\/ .*$/, ''))
    .join('\n')

describe('the page table is the one list of app pages', () => {
  it('has the three /app pages', () => {
    expect([...APP_PAGE_PATHS]).toEqual(['/app/home', '/app/accounts', '/app/agents'])
  })

  it('the nav rows are table entries', () => {
    for (const row of NAV) expect([...APP_PAGE_PATHS], row.label).toContain(row.href)
  })

  describe('the Google sign-in callbackURL default', () => {
    const calls: { callbackURL?: string }[] = []
    afterEach(() => {
      vi.unstubAllGlobals()
      calls.length = 0
    })
    it('is a table entry', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_u: string, init: { body: string }) => {
          calls.push(JSON.parse(init.body))
          return new Response(JSON.stringify({ url: 'https://accounts.google.com/x' }), { status: 200 })
        }),
      )
      await startGoogleSignIn()
      expect([...APP_PAGE_PATHS]).toContain(calls[0]!.callbackURL)
    })
  })
})

describe('server-d1 source names no old app path (D7, P1)', () => {
  const OLD = /(?:['"`]|\})\/(?:home|accounts|agents|connect)(?![\w.-])/
  it('the scan sees the sources', () => {
    expect(sources.length).toBeGreaterThan(40)
    expect(sources.map((f) => relative(SRC, f))).toContain('app/nav.ts')
  })
  it('no quoted old path in a non-test source', () => {
    const hits = sources.filter((f) => OLD.test(codeOf(readFileSync(f, 'utf8')))).map((f) => relative(SRC, f))
    expect(hits).toEqual([])
  })
  it('every quoted /app/<page> literal in a non-test source is a table entry', () => {
    const bad: string[] = []
    for (const f of sources) {
      if (relative(SRC, f) === 'app/paths.ts') continue
      for (const m of codeOf(readFileSync(f, 'utf8')).matchAll(/(?:['"`]|\})\/app\/([a-z-]+)(?![\w.-])/g)) {
        const p = `/app/${m[1]}`
        if (!(APP_PAGE_PATHS as readonly string[]).includes(p)) bad.push(`${relative(SRC, f)} ${p}`)
      }
    }
    expect(bad).toEqual([])
  })
})
