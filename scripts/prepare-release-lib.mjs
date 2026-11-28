// The two pure parts of `prepare-release.mjs` ([[OPS693]] D8): the release version the three fixed-group packages share, and the publish lines (the SDK first, then the server, then the CLI).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = [
  ['@vibase/cli', 'packages/cli'],
  ['@vibase/server-d1', 'packages/server-d1'],
  ['@vibase/sdk', 'packages/sdk'],
]

/** The version of `@vibase/cli`, `@vibase/server-d1` and `@vibase/sdk` under `root`; throws an Error naming all three and their versions when they differ. */
export function releaseVersion(root = '.') {
  const found = PACKAGES.map(([name, dir]) => ({
    name,
    version: JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).version,
  }))
  if (new Set(found.map((f) => f.version)).size > 1)
    throw new Error(`${found.map((f) => `${name(f)} ${f.version}`).join(', ')} differ`)
  return found[0].version
}
const name = (f) => f.name

/** The `npm publish` lines in the order a person runs them: the SDK has no dependency on the others, then the server, then the CLI. */
export function publishLines(version) {
  return [
    `npm publish vibase-sdk-${version}.tgz --access public`,
    `npm publish vibase-server-d1-${version}.tgz --access public`,
    `npm publish vibase-cli-${version}.tgz --access public`,
  ]
}
