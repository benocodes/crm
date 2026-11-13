// The Worker bundle's `node:` imports and size, guarded by `smoke:worker` ([[CORE243]] D2). The Worker runs with `nodejs_compat` because Better Auth imports Node modules;
// the list below is what the bundle may import, so a new Node import (a new dependency, a transitive one) is a visible change here, not drift. The size ceiling does the same for growth.
// Dynamic `import(variable)` (Better Auth's optional `node:sqlite` probe) is not a static import and is not listed.
export const ALLOWED_NODE_MODULES: readonly string[] = ['node:crypto']

/** The bundle is measured at the green commit (RESULT.md) and the ceiling set with headroom of about 10%: a jump past it is a decision, not a drift. */
export const BUNDLE_SIZE_CEILING = 4_950_000

const NODE_IMPORT = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:[^"']+)["']/g

export function nodeImportsOf(bundleText: string): string[] {
  return [...new Set([...bundleText.matchAll(NODE_IMPORT)].map((m) => m[1]!))].sort()
}

export function nodeImportProblems(bundleText: string, bytes: number): string[] {
  const out = nodeImportsOf(bundleText)
    .filter((m) => !ALLOWED_NODE_MODULES.includes(m))
    .map((m) => `the bundle imports ${m}, which is not in ALLOWED_NODE_MODULES (scripts/node-imports.ts)`)
  if (bytes > BUNDLE_SIZE_CEILING) out.push(`the bundle is ${bytes} bytes, over the ceiling of ${BUNDLE_SIZE_CEILING} (scripts/node-imports.ts)`)
  return out
}
