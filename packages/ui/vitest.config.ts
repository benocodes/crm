// `pnpm -C packages/ui test` ([[UI254]] D3a, D4): the component suites (`*.ui.test.tsx`) run once per runtime, `ui-preact` (the alias) and
// `ui-react` (real React); the engine-neutral project (the shared one) runs the node-side suites (subset scan, stylesheet, build, types).
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { engineNeutralProject, reactToPreactAlias } from '../../vitest.projects.ts'

const render = (name: string) => fileURLToPath(new URL(`./src/test/${name}`, import.meta.url))
const ui = {
  environment: 'happy-dom',
  include: ['src/**/*.ui.test.tsx'] as string[],
  testTimeout: 30_000,
  pool: 'forks',
}
const jsx = { oxc: { jsx: { runtime: 'automatic', importSource: 'react' } } } as const

export default defineConfig({
  test: {
    maxWorkers: 1,
    projects: [
      engineNeutralProject,
      {
        ...jsx,
        resolve: { alias: [...reactToPreactAlias(), { find: '#render', replacement: render('render-preact.ts') }] },
        test: { ...ui, name: 'ui-preact' },
      },
      {
        ...jsx,
        resolve: { alias: [{ find: '#render', replacement: render('render-react.ts') }] },
        test: { ...ui, name: 'ui-react' },
      },
    ],
  },
})
