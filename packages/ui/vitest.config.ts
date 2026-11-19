// `pnpm -C packages/ui test` ([[UI447]] D3): the component suites (`src/components/**/*.ui.test.tsx`) run once, in `ui-components`, under real
// React and happy-dom ([[UI448]]); the engine-neutral project (the shared one) runs the node-side suites (React scan, manifest guard, build, suite isolation).
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { engineNeutralProject } from '../../vitest.projects.ts'

const render = (name: string) => fileURLToPath(new URL(`./src/test/${name}`, import.meta.url))

export default defineConfig({
  test: {
    maxWorkers: 1,
    projects: [
      engineNeutralProject,
      {
        oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
        resolve: { alias: [{ find: '#render', replacement: render('render-react.ts') }] },
        test: {
          name: 'ui-components',
          environment: 'happy-dom',
          include: ['src/components/**/*.ui.test.tsx'],
          testTimeout: 30_000,
          pool: 'forks',
        },
      },
    ],
  },
})
