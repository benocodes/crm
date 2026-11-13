// The product version ([[OPS210]] D1, [[OPS237]] D25): the `version` of the two workspace packages of the changesets fixed group, `packages/cli` (`@vibase/cli`) and
// `packages/server-d1` (`@vibase/server-d1`). Only `changeset version` writes them. `release:build` reads both here and refuses when either is missing or they differ.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ReleaseRefusal } from './errors.js'

export const VERSION_PACKAGES = ['packages/cli', 'packages/server-d1'] as const

export function readReleaseVersion(repoRoot: string): string {
  const found = VERSION_PACKAGES.map((dir) => {
    const file = `${dir}/package.json`
    let version: unknown
    try {
      version = (JSON.parse(readFileSync(join(repoRoot, file), 'utf8')) as { version?: unknown }).version
    } catch {
      throw new ReleaseRefusal(`${file} is missing or unreadable: the release version is the version of ${VERSION_PACKAGES.map((d) => `${d}/package.json`).join(' and ')}`)
    }
    if (typeof version !== 'string' || version === '') throw new ReleaseRefusal(`${file} has no version: the release version is the version of ${VERSION_PACKAGES.map((d) => `${d}/package.json`).join(' and ')} (changesets writes it)`)
    return { file, version }
  })
  if (found[0]!.version !== found[1]!.version) throw new ReleaseRefusal(`${found[0]!.file} is at ${found[0]!.version} but ${found[1]!.file} is at ${found[1]!.version}: they are one fixed group and must be equal (run changeset version)`)
  return found[0]!.version
}
