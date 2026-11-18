// [[UI448]] group 3 (P4, 448.5): which project collects which suite files. The new React-only project collects exactly `src/components`
// suites; `ui-preact` and `ui-react` collect none of them; the shared engine-neutral project collects no `*.ui.test.tsx` at all.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const listed = (): Record<string, string[]> => {
  const out = execFileSync(
    'pnpm',
    ['exec', 'vitest', 'list', '--config', 'vitest.config.ts', '--filesOnly', '--json'],
    {
      cwd: PKG,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  const byProject: Record<string, string[]> = {}
  for (const { file, projectName } of JSON.parse(out.slice(out.indexOf('['))) as {
    file: string
    projectName: string
  }[]) {
    ;(byProject[projectName] ??= []).push(file.slice(PKG.length))
  }
  return byProject
}
const inComponents = (f: string) => f.startsWith('src/components/')

describe('suite isolation', () => {
  const projects = listed()

  it('ui-components collects only src/components component suites, and some', () => {
    const files = projects['ui-components'] ?? []
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => inComponents(f) && f.endsWith('.ui.test.tsx'))).toBe(true)
  })

  it('ui-preact and ui-react collect no src/components suite, and still the same Preact-layer suites', () => {
    for (const name of ['ui-preact', 'ui-react']) {
      const files = projects[name] ?? []
      expect(files.filter(inComponents), name).toEqual([])
      expect(files.length, name).toBe(7)
    }
  })

  it('the shared engine-neutral project collects no component suite', () => {
    const files = projects['engine-neutral'] ?? []
    expect(files.some((f) => f.endsWith('.ui.test.tsx'))).toBe(false)
  })
})
