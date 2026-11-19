// The test projects (OPS92): an engine is a vitest project, selected by file name.
//   engine-neutral  `*.test.ts` with no engine infix  needs no database server (D1 runs in-process, Miniflare)
//   d1              `*.d1.test.ts`                    the D1 side of a both-engine suite
//   postgres        `*.postgres.test.ts`              needs a Postgres database (`TEST_DATABASE_URL`, `.env.test.local`)
// Globs are relative to the directory vitest is started from: the repo root (every package) or one package (`pnpm -C packages/<pkg> test`).
import { fileURLToPath } from 'node:url'
import { configDefaults, type TestProjectInlineConfiguration } from 'vitest/config'
// For its side effect: a private TMPDIR per run, so Miniflare's leaked `miniflare-*` folders go with the run.
import './vitest.tmpdir.ts'

// `.tsx` too (UI254 D4): page tests render with the shipping runtime, real React ([[UI447]] D2).
const TESTS = '**/{src,scripts}/**/*.test.{ts,tsx}'
// `@vibase/ui`'s component suites (`*.ui.test.tsx`) run in the package's own `ui-components` project (packages/ui/vitest.config.ts, UI448, UI447 D3)
// and expect its `#render` alias, so the shared projects never collect them.
const UI_SUITES = '**/*.ui.test.tsx'
// Not workspace tests: vendored sources, other worktrees (`.claude/worktrees/*`) and the knowledge repo. The root run starts at the repo root, so the globs reach them.
const EXCLUDE = [...configDefaults.exclude, '**/dist/**', '**/vendor/**', '**/.claude/**', '**/knowledge/**']
// Every package's Postgres setup is the same one: it reads `packages/db/.env.test.local` (written by `pnpm db:test:worktree`).
const POSTGRES_SETUP = fileURLToPath(new URL('./packages/db/src/test-setup.ts', import.meta.url))

// Vitest 5 transforms with oxc, not esbuild (UI254 D4): the automatic JSX runtime on `react`, and no alias ([[UI447]] D2): `react` is React.
const reactDefault = { oxc: { jsx: { runtime: 'automatic', importSource: 'react' } } } as const

const common = {
  environment: 'node',
  // Miniflare (workerd) starts per file and the D1 golden replays, over-cap cases and concurrency trials are slow under load.
  testTimeout: 30_000,
  // One forked process per file, so each file's workerd child dies with it (OPS223 D3).
  pool: 'forks',
} as const

export const engineNeutralProject: TestProjectInlineConfiguration = {
  ...reactDefault,
  // OPS223 D3: the default projects allow files side by side (each opens a private in-memory D1); the worker count stays the root's
  // `maxWorkers: 1` unless a package's `test` script raises it (`@vibase/api`, D4).
  test: {
    ...common,
    fileParallelism: true,
    name: 'engine-neutral',
    include: [TESTS],
    exclude: [...EXCLUDE, UI_SUITES, '**/*.d1.test.ts', '**/*.postgres.test.ts'],
  },
}
// UI446 D3, UI460 D4: the auth pages' suites (`packages/server-d1/src/ui/*.ui.test.tsx`) and the workspace app's (`src/app/*.ui.test.tsx`) run on real React,
// so Radix and `react-dom` are tested on the runtime that ships. The shared project above never collects `*.ui.test.tsx`; this one stays its own project
// (UI447 D3): it collects only the `*.ui.test.tsx` files under `src/{ui,app}`.
export const pageUiProject: TestProjectInlineConfiguration = {
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  test: {
    ...common,
    fileParallelism: true,
    name: 'page-ui',
    include: ['**/src/{ui,app}/**/*.ui.test.tsx'],
    exclude: EXCLUDE,
  },
}
export const d1Project: TestProjectInlineConfiguration = {
  test: {
    ...common,
    fileParallelism: true,
    name: 'd1',
    include: ['**/{src,scripts}/**/*.d1.test.ts'],
    exclude: EXCLUDE,
  },
}
export const postgresProject: TestProjectInlineConfiguration = {
  // OPS223 D5: the Postgres suites share one per-worktree database (invariant 2): always serial.
  test: {
    ...common,
    fileParallelism: false,
    name: 'postgres',
    include: ['**/{src,scripts}/**/*.postgres.test.ts'],
    exclude: EXCLUDE,
    setupFiles: [POSTGRES_SETUP],
  },
}
