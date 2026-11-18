// `pnpm -C packages/ui test` ([[UI254]] D3a, D4): the Preact layer's component suites (`src/*.ui.test.tsx`) run once per runtime, `ui-preact`
// (the alias) and `ui-react` (real React); the new React layer's suites (`src/components`, [[UI448]] P4) run in `ui-components`, under real
// React only; the engine-neutral project (the shared one) runs the node-side suites (React scan, stylesheet, build, types, suite isolation).
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
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
        test: { ...ui, name: 'ui-preact', exclude: [...configDefaults.exclude, 'src/components/**'] },
      },
      {
        ...jsx,
        resolve: { alias: [{ find: '#render', replacement: render('render-react.ts') }] },
        test: { ...ui, name: 'ui-react', exclude: [...configDefaults.exclude, 'src/components/**'] },
      },
      {
        ...jsx,
        resolve: { alias: [{ find: '#render', replacement: render('render-react.ts') }] },
        test: { ...ui, name: 'ui-components', include: ['src/components/**/*.ui.test.tsx'] },
      },
    ],
  },
})
