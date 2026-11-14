// Group 6, stylesheet half ([[UI254]] D5): the dark-mode redefinition, the focus ring and the `vb-` prefix are checked on the file, not by eye.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./ui.css', import.meta.url)), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

interface Block {
  /** Selector prelude, or the at-rule header. */
  prelude: string
  body: string
  children: Block[]
}

/** A minimal brace parser: enough for rules, `@media` and nesting-free CSS. */
function parse(text: string): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    const prelude = text.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') depth--
      j++
    }
    const body = text.slice(open + 1, j - 1)
    out.push({ prelude, body, children: body.includes('{') ? parse(body) : [] })
    i = j
  }
  return out
}

const tokens = (body: string): string[] => [...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!)
const blocks = parse(css)
const allRules = (bs: Block[]): Block[] => bs.flatMap((b) => (b.children.length ? allRules(b.children) : [b]))

const rootTokens = blocks.filter((b) => b.prelude === ':root').flatMap((b) => tokens(b.body))
const rootColours = rootTokens.filter((t) => t.startsWith('--vb-color-'))
const media = blocks.find((b) => /^@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)$/.test(b.prelude))
const mediaDark = media?.children.find((b) => b.prelude === ':root:not([data-theme="light"])')
const forcedDark = blocks.find((b) => b.prelude === ':root[data-theme="dark"]')
const forcedLight = blocks.find((b) => b.prelude === ':root[data-theme="light"]')

describe('ui.css', () => {
  it('defines colour tokens on :root', () => {
    expect(rootColours.length).toBeGreaterThan(5)
    expect(rootTokens.some((t) => t.startsWith('--vb-space-'))).toBe(true)
    expect(rootTokens).toContain('--vb-radius')
  })

  it('redefines every colour token under prefers-color-scheme: dark (unless the page forces light)', () => {
    expect(mediaDark, 'a prefers-color-scheme: dark block on :root:not([data-theme="light"])').toBeDefined()
    expect(tokens(mediaDark!.body).sort()).toEqual([...rootColours].sort())
  })

  it('redefines every colour token under [data-theme="dark"]', () => {
    expect(forcedDark, 'a :root[data-theme="dark"] block').toBeDefined()
    expect(tokens(forcedDark!.body).sort()).toEqual([...rootColours].sort())
  })

  it('has a [data-theme="light"] block (it forces light by escaping the media block)', () => {
    expect(forcedLight).toBeDefined()
  })

  it('has a :focus-visible rule', () => {
    expect(allRules(blocks).some((b) => /:focus-visible/.test(b.prelude))).toBe(true)
  })

  it('prefixes every class selector with vb-', () => {
    const classes = allRules(blocks).flatMap((b) => [...b.prelude.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!))
    expect(classes.length).toBeGreaterThan(10)
    expect(classes.filter((c) => !c.startsWith('vb-'))).toEqual([])
  })

  it('has no inline-style escape hatches (url() to a remote host, @import)', () => {
    expect(css).not.toMatch(/@import|url\(\s*['"]?https?:/)
  })
})
