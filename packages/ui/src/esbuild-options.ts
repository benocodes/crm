// The one esbuild options object every page build spreads into its `build()` call ([[UI254]] D1, D4). Components and pages import from
// `react` and compile with the automatic JSX runtime (`jsxImportSource: 'react'`); the alias map makes every bundle ship Preact.
// (No `esbuild` import: the scan keeps `src` to `react` and relative files; the object is plain data esbuild's `build()` accepts.)
// esbuild resolves an alias target from its working directory, so a page package that builds with this needs `preact` as a dependency and
// runs the build from its own directory (or sets `absWorkingDir`).
/** React specifier to the Preact module that replaces it. The vitest default and the page builds both read this one map. */
export const REACT_TO_PREACT_ALIAS = {
  react: 'preact/compat',
  'react-dom': 'preact/compat',
  'react-dom/client': 'preact/compat/client',
  'react/jsx-runtime': 'preact/jsx-runtime',
  'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
} as const

export const esbuildOptions = {
  jsx: 'automatic',
  jsxImportSource: 'react',
  alias: { ...REACT_TO_PREACT_ALIAS },
} as const

/** The stylesheet every page copies beside its bundle. */
export const stylesheetPath = new URL('./ui.css', import.meta.url)
