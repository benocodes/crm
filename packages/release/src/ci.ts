// The CI side of the release ([[OPS237]] P1, P2): the tag check and the release-asset list, called by `.github/workflows/release.yml` through `scripts/ci.ts`.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ReleaseRefusal } from './errors.js'

export type TagDecision = { mode: 'build-only' } | { mode: 'release'; tag: string }

const SEMVER_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * What a run is: a dispatch on a branch builds only; a run on a tag must be `v<version>` exactly (D1's version: the fixed group of `packages/cli` and `packages/server-d1`) or it refuses,
 * naming both, before the gate runs. The workflow's release job runs only after this has returned `release`.
 */
export function decideTag(run: { refType?: string; refName?: string }, version: string): TagDecision {
  if (run.refType !== 'tag') return { mode: 'build-only' }
  const tag = run.refName ?? ''
  if (!SEMVER_TAG.test(tag)) throw new ReleaseRefusal(`the tag ${JSON.stringify(tag)} is not v<semver>; the release version is ${version}, so the tag must be v${version}`)
  if (tag !== `v${version}`) throw new ReleaseRefusal(`the tag ${tag} does not match the release version ${version} (packages/cli/package.json and packages/server-d1/package.json): the tag must be v${version}`)
  return { mode: 'release', tag }
}

/** The three files a release carries, as paths in `dist`: both tarballs and `SHA256SUMS` for this version. Anything missing or extra in `dist` refuses, naming it. */
export function releaseAssets(dist: string, version: string): string[] {
  const want = [`vibase-cli-${version}.tgz`, `vibase-server-d1-${version}.tgz`, 'SHA256SUMS']
  const found = existsSync(dist) ? readdirSync(dist) : []
  const problems = [
    ...want.filter((f) => !found.includes(f)).map((f) => `${f} is missing`),
    ...found.filter((f) => !want.includes(f)).map((f) => `${f} is extra`),
  ]
  if (problems.length) throw new ReleaseRefusal(`${dist} does not hold exactly the release assets of ${version}: ${problems.join('; ')}`)
  return want.map((f) => join(dist, f))
}
