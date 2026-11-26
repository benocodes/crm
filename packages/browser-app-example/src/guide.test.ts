// DX637 group 3 (P6): the browser-apps guide exists and sits in the docs navigation after the OAuth clients page. Structural only: its wording is
// checked by review (the #531 ruling, 637.10).
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const docs = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'src')

describe('the browser-apps guide', () => {
  it('is a page of the docs site', () => {
    expect(existsSync(join(docs, 'content', 'docs', 'guides', 'browser-apps.md'))).toBe(true)
  })
  it('is in nav.mjs, in the section of the OAuth clients page, right after it', async () => {
    const { sections } = (await import(pathToFileURL(join(docs, 'nav.mjs')).href)) as {
      sections: { label: string; items?: { slug: string }[] }[]
    }
    const section = sections.find((s) => s.items?.some((i) => i.slug === 'guides/oauth-clients'))!
    const slugs = section.items!.map((i) => i.slug)
    expect(slugs[slugs.indexOf('guides/oauth-clients') + 1]).toBe('guides/browser-apps')
  })
})
