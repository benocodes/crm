// [[UI448]] group 3 (P4, 448.5), reduced by [[UI447]] D3: which project collects which suite files. `ui-components` collects exactly the
// `src/components` suites, the shared engine-neutral project collects no `*.ui.test.tsx` at all, and no `ui-preact` or `ui-react` project exists.
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

  it('the project list is exactly engine-neutral and ui-components: no ui-preact, no ui-react', () => {
    expect(Object.keys(projects).sort()).toEqual(['engine-neutral', 'ui-components'])
  })

  it('the shared engine-neutral project collects no component suite', () => {
    const files = projects['engine-neutral'] ?? []
    expect(files.some((f) => f.endsWith('.ui.test.tsx'))).toBe(false)
  })
})
