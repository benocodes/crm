import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// [[UI30]] D10 and D8: a source guard over the page code (every non-test file under src/connect). The runtime tests prove the behaviour;
// this stops a markup sink or a storage write from being added where no test looks.

const DIR = fileURLToPath(new URL('.', import.meta.url))
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ f, text: readFileSync(DIR + f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '') }))

describe('page source guard', () => {
  it('finds the page modules', () => {
    expect(sources.map((s) => s.f)).toEqual(expect.arrayContaining(['view-model.ts', 'controller.ts', 'dom.ts', 'api.ts', 'main.ts']))
  })
  it.each(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'DOMParser', 'eval(', 'new Function'])('no page module uses %s', (sink) => {
    for (const s of sources) expect(s.text, `${s.f} uses ${sink}`).not.toContain(sink)
  })
  it.each(['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB'])('no page module touches %s', (store) => {
    for (const s of sources) expect(s.text, `${s.f} touches ${store}`).not.toContain(store)
  })
  it('the page HTML has no inline script, inline handler or inline style', () => {
    const html = readFileSync(DIR + 'index.html', 'utf8')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i)
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(html).not.toMatch(/<style|\sstyle\s*=/i)
  })
})
