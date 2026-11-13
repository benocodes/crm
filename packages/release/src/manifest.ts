// The release manifest `release.json` ([[OPS210]] D4): its build and the verification every consumer runs before trusting a package directory.
export interface ReleaseManifest {
  name: string
  version: string
  commit: string
  built_at: string
  wrangler: string
  compatibility_date: string
  node: string
  migrations: { name: string; sha256: string }[]
  files: Record<string, string>
}
export interface Problem {
  path: string
  kind: 'mismatch' | 'missing' | 'extra'
}
export interface ManifestInput {
  dir: string
  version: string
  commit: string
  builtAt: string
  wrangler: string
  compatibilityDate: string
  node: string
  migrations: readonly { name: string; sha256: string }[]
}
export const sha256 = (_bytes: Uint8Array | string): string => {
  throw new Error('not implemented')
}
export const listFiles = (_dir: string): string[] => {
  throw new Error('not implemented')
}
export const buildReleaseManifest = (_input: ManifestInput): ReleaseManifest => {
  throw new Error('not implemented')
}
export const verifyRelease = (_dir: string): Problem[] => {
  throw new Error('not implemented')
}
export const assertRelease = (_dir: string): void => {
  throw new Error('not implemented')
}
