// The Worker bundle's `node:` imports, guarded by `smoke:worker` ([[CORE243]] D2). The Worker runs with `nodejs_compat` because Better Auth imports Node modules;
// the list below is what the bundle may import, so a new Node import (a new dependency, a transitive one) is a visible change here, not drift.
// Dynamic `import(variable)` (Better Auth's optional `node:sqlite` probe) is not a static import and is not listed.
export const ALLOWED_NODE_MODULES: readonly string[] = ['node:crypto']

const NODE_IMPORT = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:[^"']+)["']/g

export function nodeImportsOf(bundleText: string): string[] {
  return [...new Set([...bundleText.matchAll(NODE_IMPORT)].map((m) => m[1]!))].sort()
}

export function nodeImportProblems(bundleText: string): string[] {
  return nodeImportsOf(bundleText)
    .filter((m) => !ALLOWED_NODE_MODULES.includes(m))
    .map((m) => `the bundle imports ${m}, which is not in ALLOWED_NODE_MODULES (scripts/node-imports.ts)`)
}
