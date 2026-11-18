import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// [[UI30]] D10 and D8: a source guard over the page code (every non-test file under src/connect). The runtime tests prove the behaviour;
// this stops a markup sink or a storage write from being added where no test looks.

const DIR = fileURLToPath(new URL('.', import.meta.url))
// [[UI460]] D4: the session seam moved to `src/app/session/`; the guard reads it too, so the sinks stay out of the one copy `/connect` and the app share.
const SESSION = fileURLToPath(new URL('../app/session/', import.meta.url))
const read = (dir: string, prefix: string) =>
  readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => ({
      f: prefix + f,
      text: readFileSync(dir + f, 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, ''),
    }))
const sources = [...read(DIR, ''), ...read(SESSION, 'session/')]

describe('page source guard', () => {
  it('finds the page modules', () => {
    expect(sources.map((s) => s.f)).toEqual(
      expect.arrayContaining([
        'view-model.ts',
        'controller.ts',
        'view.tsx',
        'main.tsx',
        'session/api.ts',
        'session/better-auth-session.ts',
        'session/clerk-window.ts',
        'session/seam.ts',
      ]),
    )
  })
  // [[UI460]] D4 (group 3): one copy of the seam, the session, the Clerk window and the API client, under src/app/session/.
  it('src/connect holds no seam, session, Clerk-window or API-client implementation of its own', () => {
    const own = read(DIR, '').map((s) => s.f)
    for (const gone of ['seam.ts', 'api.ts', 'better-auth-session.ts', 'clerk-window.ts']) expect(own).not.toContain(gone)
    for (const s of read(DIR, '')) {
      expect(s.text, s.f).not.toContain('window.Clerk')
      expect(s.text, s.f).not.toMatch(/\/auth\/(get-session|token|sign-out)/)
      expect(s.text, s.f).not.toContain('/meta/v1/')
    }
  })
  it.each([
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'document.write',
    'createContextualFragment',
    'DOMParser',
    'dangerouslySetInnerHTML',
    'eval(',
    'new Function',
  ])('no page module uses %s', (sink) => {
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
