import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// [[API503]] D2: every non-test source derives these URLs from its constant. The old paths appear nowhere; a new path
// appears as a literal only in the line that defines its constant (a comment may name it).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
// `channels/gmail/push.js` is a module path, not the URL
const OLD = [/\/oauth\/google\/callback/, /\/gmail\/push(?!\.js)/, /\/webhooks\/clerk/]
const NEW = ['/oauth/callback/google', '/inbound/gmail', '/inbound/clerk']
const DEFINITIONS = [
  /export const CALLBACK_PATH = '\/oauth\/callback\/google'/,
  /export const PUSH_PATH = '\/inbound\/gmail'/,
  /export const CLERK_WEBHOOK_PATH = '\/inbound\/clerk'/,
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'fixtures') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|\.e2e\.ts$|\.suite\.ts$/.test(name)) out.push(p)
  }
  return out
}
const sources = (): string[] => {
  const files: string[] = []
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    const base = join(ROOT, 'packages', pkg)
    if (!statSync(base).isDirectory()) continue
    for (const sub of ['src', 'scripts']) {
      try {
        walk(join(base, sub), files)
      } catch {
        /* no such folder */
      }
    }
  }
  // test support under src/test is test code, whose literals pin the wire values
  return files.filter((f) => !relative(ROOT, f).includes('/src/test/'))
}
const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l)

describe('machine-endpoint paths in non-test source (API503 D2)', () => {
  const files = sources()
  it('scans the packages', () => expect(files.length).toBeGreaterThan(100))
  it('no source names an old path, comments included', () => {
    const hits = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((l, i) => (OLD.some((o) => o.test(l)) ? [`${relative(ROOT, f)}:${i + 1}`] : [])),
    )
    expect(hits).toEqual([])
  })
  it('a new path is a literal only where its constant is defined', () => {
    const hits = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((l, i) =>
          !isComment(l) && NEW.some((n) => l.includes(n)) && !DEFINITIONS.some((d) => d.test(l))
            ? [`${relative(ROOT, f)}:${i + 1}: ${l.trim().slice(0, 100)}`]
            : [],
        ),
    )
    expect(hits).toEqual([])
  })
})
