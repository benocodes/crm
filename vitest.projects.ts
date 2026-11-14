// The test projects (OPS92): an engine is a vitest project, selected by file name.
//   engine-neutral  `*.test.ts` with no engine infix  needs no database server (D1 runs in-process, Miniflare)
//   d1              `*.d1.test.ts`                    the D1 side of a both-engine suite
//   postgres        `*.postgres.test.ts`              needs a Postgres database (`TEST_DATABASE_URL`, `.env.test.local`)
// Globs are relative to the directory vitest is started from: the repo root (every package) or one package (`pnpm -C packages/<pkg> test`).
import { fileURLToPath } from 'node:url'
import { configDefaults, type TestProjectInlineConfiguration } from 'vitest/config'
import { REACT_TO_PREACT_ALIAS } from './packages/ui/src/esbuild-options.ts'

// `.tsx` too (UI254 D4): page tests render with the shipping runtime.
const TESTS = '**/{src,scripts}/**/*.test.{ts,tsx}'
// `@vibase/ui`'s component suites (`*.ui.test.tsx`) run once per runtime in the package's own `ui-preact` / `ui-react` projects (UI254 D3a,
// packages/ui/vitest.config.ts) and expect the runtime of that project, so the shared projects never collect them.
const UI_SUITES = '**/*.ui.test.tsx'
// Not workspace tests: vendored sources, other worktrees (`.claude/worktrees/*`) and the knowledge repo. The root run starts at the repo root, so the globs reach them.
const EXCLUDE = [...configDefaults.exclude, '**/dist/**', '**/vendor/**', '**/.claude/**', '**/knowledge/**']
// Every package's Postgres setup is the same one: it reads `packages/db/.env.test.local` (written by `pnpm db:test:worktree`).
const POSTGRES_SETUP = fileURLToPath(new URL('./packages/db/src/test-setup.ts', import.meta.url))

/** `react` and its JSX runtimes to Preact, as the page builds do (UI254 D1, D4): bare specifiers, resolved from the importing file. Exact match, so `react/jsx-runtime` is not caught by the `react` entry. */
export const reactToPreactAlias = () =>
  Object.entries(REACT_TO_PREACT_ALIAS).map(([from, to]) => ({ find: new RegExp(`^${from.replace(/[/-]/g, '\\$&')}$`), replacement: to }))
// Vitest 5 transforms with oxc, not esbuild (UI254 D4): the automatic JSX runtime on `react` is set here and the alias above sends it to Preact.
const preactDefault = { oxc: { jsx: { runtime: 'automatic', importSource: 'react' } }, resolve: { alias: reactToPreactAlias() } } as const

const common = {
  environment: 'node',
  // Miniflare (workerd) starts per file and the D1 golden replays, over-cap cases and concurrency trials are slow under load.
  testTimeout: 30_000,
  // One forked process per file, so each file's workerd child dies with it (OPS223 D3).
  pool: 'forks',
} as const

export const engineNeutralProject: TestProjectInlineConfiguration = {
  ...preactDefault,
  // OPS223 D3: the default projects allow files side by side (each opens a private in-memory D1); the worker count stays the root's
  // `maxWorkers: 1` unless a package's `test` script raises it (`@vibase/api`, D4).
  test: { ...common, fileParallelism: true, name: 'engine-neutral', include: [TESTS], exclude: [...EXCLUDE, UI_SUITES, '**/*.d1.test.ts', '**/*.postgres.test.ts'] },
}
export const d1Project: TestProjectInlineConfiguration = {
  test: { ...common, fileParallelism: true, name: 'd1', include: ['**/{src,scripts}/**/*.d1.test.ts'], exclude: EXCLUDE },
}
export const postgresProject: TestProjectInlineConfiguration = {
  // OPS223 D5: the Postgres suites share one per-worktree database (invariant 2): always serial.
  test: { ...common, fileParallelism: false, name: 'postgres', include: ['**/{src,scripts}/**/*.postgres.test.ts'], exclude: EXCLUDE, setupFiles: [POSTGRES_SETUP] },
}
