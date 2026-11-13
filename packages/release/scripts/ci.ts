// `pnpm release:ci tag|assets` ([[OPS237]] P2): what `.github/workflows/release.yml` calls. `tag` reads GITHUB_REF_TYPE and GITHUB_REF_NAME and exits 1 with the
// refusal when a tag run's tag is not v<version>; `assets` prints the three release files (refusing a missing or extra one), one path per line.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideTag, releaseAssets } from '../src/ci.js'
import { ReleaseRefusal } from '../src/errors.js'
import { readReleaseVersion } from '../src/version.js'

const PKG = fileURLToPath(new URL('..', import.meta.url))

try {
  const version = readReleaseVersion(join(PKG, '..', '..'))
  const [command] = process.argv.slice(2)
  if (command === 'tag') {
    const d = decideTag({ refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME }, version)
    console.log(d.mode === 'release' ? `tag ${d.tag} matches release version ${version}: this run ends in a draft release` : `no tag: a build-only run of version ${version}`)
  } else if (command === 'assets') {
    for (const f of releaseAssets(join(PKG, 'dist'), version)) console.log(f)
  } else {
    console.error('usage: release:ci tag | assets')
    process.exit(2)
  }
} catch (e) {
  if (!(e instanceof ReleaseRefusal)) throw e
  console.error(`release: ${e.message}`)
  process.exit(1)
}
