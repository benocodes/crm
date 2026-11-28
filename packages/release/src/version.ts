// The product version ([[OPS210]] D1, [[OPS237]] D25): the `version` of the three workspace packages of the changesets fixed group, `packages/cli` (`@vibase/cli`),
// `packages/server-d1` (`@vibase/server-d1`) and `packages/sdk` (`@vibase/sdk`, [[OPS693]]). Only `changeset version` writes them. `release:build` reads all three here and refuses when any is missing or they differ.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ReleaseRefusal } from './errors.js'

export const VERSION_PACKAGES = ['packages/cli', 'packages/server-d1', 'packages/sdk'] as const

export function readReleaseVersion(repoRoot: string): string {
  const found = VERSION_PACKAGES.map((dir) => {
    const file = `${dir}/package.json`
    let version: unknown
    try {
      version = (JSON.parse(readFileSync(join(repoRoot, file), 'utf8')) as { version?: unknown }).version
    } catch {
      throw new ReleaseRefusal(
        `${file} is missing or unreadable: the release version is the version of ${VERSION_PACKAGES.map((d) => `${d}/package.json`).join(', ')}`,
      )
    }
    if (typeof version !== 'string' || version === '')
      throw new ReleaseRefusal(
        `${file} has no version: the release version is the version of ${VERSION_PACKAGES.map((d) => `${d}/package.json`).join(', ')} (changesets writes it)`,
      )
    return { file, version }
  })
  if (new Set(found.map((f) => f.version)).size > 1)
    throw new ReleaseRefusal(
      `${found.map((f) => `${f.file} is at ${f.version}`).join(', ')}: they are one fixed group and must be equal (run changeset version)`,
    )
  return found[0]!.version
}
