// The staged package directory: the cycle-1 layout of [[OPS210]] D3, with its `package.json` and `release.json`.
import type { ReleaseManifest } from './manifest.js'
export interface StageInput {
  outDir: string
  version: string
  commit: string
  builtAt: string
  wranglerVersion: string
  compatibilityDate: string
  node: string
  cliJs: string
  workerEntry: string
  assetsConnectDir: string
  migrationsDir: string
  baseConfigText: string
  license: string
  readme: string
  migrations: readonly { name: string; sha256: string }[]
}
export const readWranglerVersion = (_serverD1PackageJson: string): string => {
  throw new Error('not implemented')
}
export const publishedPackageJson = (_version: string, _wrangler: string): Record<string, unknown> => {
  throw new Error('not implemented')
}
export const deriveBaseConfig = (_sourceText: string, _paths: { main: string; assetsDirectory: string; migrationsDir: string }): Record<string, unknown> => {
  throw new Error('not implemented')
}
export const stageRelease = (_input: StageInput): ReleaseManifest => {
  throw new Error('not implemented')
}
