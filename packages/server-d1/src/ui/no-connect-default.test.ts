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

// [[UI476]] D10, [[UI479]] P2 (479.2, group 1) and [[UI507]] D6: the Preact /connect page is deleted and `/connect` is a 404, so nothing a person or a test reads names `/connect` as a path outside the allow-list (what is left are the 404 assertions and the notes that say it is gone):
// the redirect and its test, the `return_to` allow-list (`continuation.ts`) and its tests, the `run_worker_first` lists with their pins, the README's note that an old link still lands on /home, the E2E that asserts the redirect.
// The scan reads server-d1 `src`, `scripts` and `e2e`, the release package, the docs content and the named files; it matches a bare path and a host-qualified URL (`https://h/connect`, `http://localhost:8787/connect`, `https://<api host>/connect`, 476.15).
// An allow-listed file pins HOW MANY mentions it has, so a new one turns the scan red.
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const DIR_ROOTS = [
  'packages/server-d1/src',
  'packages/server-d1/scripts',
  'packages/server-d1/e2e',
  'packages/release/src',
  'packages/release/scripts',
  'packages/release/templates',
  'packages/docs/src/content',
]
const FILE_ROOTS = [
  'packages/server-d1/README.md',
  'packages/server-d1/clerk-setup.md',
  'packages/server-d1/.dev.vars.example',
  'packages/server-d1/wrangler.jsonc',
]
/** Allowed files and how many `/connect` mentions each has. */
const ALLOWED: Record<string, number> = {
  'packages/release/scripts/check.ts': 3,
  'packages/server-d1/README.md': 2,
  'packages/server-d1/clerk-setup.md': 1,
  'packages/server-d1/e2e/auth-pages.e2e.ts': 5,
  'packages/server-d1/e2e/oauth-pages.e2e.ts': 6,
  'packages/server-d1/scripts/dev-server.test.ts': 2,
  'packages/server-d1/scripts/smoke-worker.ts': 7,
  'packages/server-d1/src/static-serving.test.ts': 12,
  'packages/server-d1/src/static-serving.ts': 1,
  'packages/server-d1/src/ui/continuation.test.ts': 2,
  'packages/server-d1/src/ui/sign-in-page.ui.test.tsx': 2,
  'packages/server-d1/src/wrangler-config.test.ts': 4,
  'packages/server-d1/wrangler.jsonc': 1,
}
/** `/connect` as a whole path segment: not `/connections`, `/connect-return`, `/oauth/connect`, a file name, or the start of a regex literal or an escaped slash (`(/connect an agent/`, `\/connect`). */
export const CONNECT_PATH = /(?<![\w/.\-\\])\/connect(?![\w-])(?! an agent\/)/g
/** `/connect` after a host: `https://h/connect`, `http://localhost:8787/connect`, `https://<api host>/connect`; not `/connect.js`, `/connect-return`, `/connections`. */
export const CONNECT_HOST = /https?:\/\/(?:[^\s'"`<]|<[^>]*>)*?\/connect(?![\w-]|\.\w)/g
export const connectMentions = (text: string): number => {
  const hostForm = text.match(CONNECT_HOST)?.length ?? 0
  const bare = text.replace(CONNECT_HOST, '').match(CONNECT_PATH)?.length ?? 0
  return hostForm + bare
}
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
const SELF = 'packages/server-d1/src/ui/no-connect-default.test.ts'
const sources = [
  ...DIR_ROOTS.flatMap((r) => walk(join(REPO, r)))
    .filter((f) => /\.(tsx?|jsonc?|css|html|mdx?|example)$/.test(f) && !f.includes('node_modules'))
    .map((f) => relative(REPO, f))
    .filter((f) => f !== SELF), // the matcher's own table names the forms it matches
  ...FILE_ROOTS,
]
const mentions = (f: string) => connectMentions(readFileSync(join(REPO, f), 'utf8'))

describe('the /connect matcher (UI479 group 1)', () => {
  it.each([
    ["page.goto('/connect')", 1],
    ["page.goto('/connect?x=1')", 1],
    ['open https://api.hq.vibase.ai/connect', 1],
    ['https://<api host>/connect', 1],
    ['http://localhost:8787/connect', 1],
    ['`${BASE}/connect`', 1],
    ['an old /connect link', 1],
    ['(/connect)', 1],
    ["import { connectOperation } from '../../api/src/connections/connect.js'", 0],
    ["from './connect.js'", 0],
    ['https://h/connect.js', 0],
    ['/connections', 0],
    ['https://h/connections', 0],
    ['/connect-return', 0],
    ['https://h/connect-return', 0],
    ['connect.ts', 0],
    ['/oauth/connect', 0],
    ['/(\\/connect an agent)/', 0],
    ['(/connect an agent/', 0],
    ['https://h/connect and /connect', 2],
  ])('%s -> %i', (text, n) => {
    expect(connectMentions(text)).toBe(n)
  })
})

describe("no source names '/connect' as a path outside the allow-list (UI476, UI479)", () => {
  it('the scan sees the packages it is about', () => {
    expect(sources.length).toBeGreaterThan(100)
    expect(sources).toContain('packages/server-d1/src/static-serving.ts')
    for (const f of [
      'packages/server-d1/e2e/mcp-oauth.e2e.ts',
      'packages/server-d1/README.md',
      'packages/server-d1/.dev.vars.example',
      'packages/docs/src/content/docs/getting-started/quickstart.md',
      'packages/release/templates/server-d1-README.md',
    ])
      expect(sources, f).toContain(f)
  })
  it('every other file is free of it', () => {
    const hits = sources.filter((f) => !(f in ALLOWED) && mentions(f) > 0)
    expect(hits).toEqual([])
  })
  it('an allow-listed file has exactly the pinned number of mentions (no new one, no stale entry)', () => {
    for (const [f, n] of Object.entries(ALLOWED)) expect(mentions(f), f).toBe(n)
  })
})

// [[UI479]] P3 (479.3, group 2): no skill or AGENTS.md cites an artefact UI476 deleted.
describe('no skill or AGENTS.md cites a deleted /connect artefact (UI479)', () => {
  const DEAD = [
    'src/connect/',
    'connect-serving',
    'build-connect',
    'e2e:connect',
    'connect.e2e.ts',
    'connect-seam',
    'connectCsp',
  ]
  const docs = [...walk(join(REPO, '.agents/skills')).filter((f) => f.endsWith('.md')), join(REPO, 'AGENTS.md')]
  it('the scan sees the skills', () => {
    expect(docs.length).toBeGreaterThan(10)
  })
  it.each(DEAD)('nothing cites %s', (dead) => {
    const hits = docs.filter((f) => readFileSync(f, 'utf8').includes(dead)).map((f) => relative(REPO, f))
    expect(hits).toEqual([])
  })
})

// [[UI479]] P4 (group 3): the docs name the new places, and only existing scripts.
describe('the docs name /app/home and /app/agents (UI479, UI507)', () => {
  const read = (f: string) => readFileSync(join(REPO, f), 'utf8')
  const readme = read('packages/server-d1/README.md')
  it('the quickstart names the Agents page and no longer a /connect portal', () => {
    const q = read('packages/docs/src/content/docs/getting-started/quickstart.md')
    expect(q).toContain('/app/agents')
    expect(q).not.toMatch(/connect`? portal/)
  })
  it('the README names /home as the landing page and /agents', () => {
    expect(readme).toContain('`/app/home`')
    expect(readme).toContain('`/app/agents`')
  })
  it('every e2e script the README names exists in package.json', () => {
    const pkg = JSON.parse(read('packages/server-d1/package.json')) as { scripts: Record<string, string> }
    const named = [...readme.matchAll(/\be2e:[a-z][a-z-]*/g)].map((m) => m[0])
    expect(named.length).toBeGreaterThan(0)
    for (const n of named) expect(pkg.scripts, n).toHaveProperty(n)
  })
})
