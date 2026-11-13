// Red-commit stub ([[CORE243]] D2): the allow-list of `node:` modules in the Worker bundle and its size ceiling are implemented in the green commit.
export const ALLOWED_NODE_MODULES: readonly string[] = []
export const BUNDLE_SIZE_CEILING = 0
export function nodeImportsOf(_bundleText: string): string[] {
  return []
}
export function nodeImportProblems(_bundleText: string, _bytes: number): string[] {
  return []
}
