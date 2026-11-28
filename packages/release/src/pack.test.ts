// [[OPS210]] D2/D3 as built (OPS240): three npm tarballs and one SHA256SUMS in dist, the old single tarball gone.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sdkSources, sources } from './fixtures.js'
import { listFiles } from './manifest.js'
import { packRelease, verifySums } from './pack.js'
import { stageClient, stageSdk, stageServer } from './stage.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')
const tarList = (tgz: string) =>
  execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l !== '')
    .sort()

function built() {
  const s = sources()
  dirs.push(s.root)
  const clientDir = tmp('ops240-c-')
  const serverDir = tmp('ops240-s-')
  stageClient({ ...s, outDir: clientDir })
  stageServer({ ...s, outDir: serverDir })
  const sdkSrc = sdkSources()
  dirs.push(sdkSrc.root)
  const sdkDir = tmp('ops693-sdk-')
  stageSdk({ ...sdkSrc, version: s.version, outDir: sdkDir })
  const dist = tmp('ops240-dist-')
  return { s, clientDir, serverDir, sdkDir, dist }
}

describe('the build output, per package (the matrix: client x server)', () => {
  it('dist holds exactly vibase-cli-<v>.tgz, vibase-server-d1-<v>.tgz, vibase-sdk-<v>.tgz and SHA256SUMS: no vibase-<v>.tgz, and a stale one is removed', () => {
    const { s, clientDir, serverDir, sdkDir, dist } = built()
    writeFileSync(join(dist, `vibase-${s.version}.tgz`), 'stale single tarball')
    const out = packRelease({ clientDir, serverDir, sdkDir, dist, version: s.version })
    expect(readdirSync(dist).sort()).toEqual(
      [
        `vibase-cli-${s.version}.tgz`,
        `vibase-server-d1-${s.version}.tgz`,
        `vibase-sdk-${s.version}.tgz`,
        'SHA256SUMS',
      ].sort(),
    )
    expect(out).toEqual({
      client: join(dist, `vibase-cli-${s.version}.tgz`),
      server: join(dist, `vibase-server-d1-${s.version}.tgz`),
      sdk: join(dist, `vibase-sdk-${s.version}.tgz`),
      sums: join(dist, 'SHA256SUMS'),
    })
  })
  it("each tarball holds D3's list and nothing else", () => {
    const { s, clientDir, serverDir, sdkDir, dist } = built()
    const out = packRelease({ clientDir, serverDir, sdkDir, dist, version: s.version })
    expect(tarList(out.client)).toEqual(
      ['LICENSE', 'README.md', 'cli/vibase.js', 'package.json'].map((f) => `package/${f}`).sort(),
    )
    expect(tarList(out.server)).toEqual(
      listFiles(serverDir)
        .map((f) => `package/${f}`)
        .sort(),
    )
    expect(tarList(out.server)).toContain('package/release.json')
    expect(tarList(out.client)).not.toContain('package/release.json')
    expect(tarList(out.sdk)).toEqual(
      listFiles(sdkDir)
        .map((f) => `package/${f}`)
        .sort(),
    )
    expect(tarList(out.sdk)).toContain('package/dist/index.js')
  })
  it('SHA256SUMS lists all three tarballs, by file name, with the right sums, in the `sha256sum` format', () => {
    const { s, clientDir, serverDir, sdkDir, dist } = built()
    const out = packRelease({ clientDir, serverDir, sdkDir, dist, version: s.version })
    const lines = readFileSync(out.sums, 'utf8').trimEnd().split('\n')
    expect(lines).toEqual([
      `${sha(out.client)}  vibase-cli-${s.version}.tgz`,
      `${sha(out.server)}  vibase-server-d1-${s.version}.tgz`,
      `${sha(out.sdk)}  vibase-sdk-${s.version}.tgz`,
    ])
    expect(verifySums(dist)).toEqual([])
  })
  it('verifySums names a tarball whose bytes changed, one that is missing, and one the file does not list', () => {
    const { s, clientDir, serverDir, sdkDir, dist } = built()
    const out = packRelease({ clientDir, serverDir, sdkDir, dist, version: s.version })
    writeFileSync(out.client, 'tampered')
    expect(verifySums(dist)).toEqual([`vibase-cli-${s.version}.tgz (mismatch)`])
    rmSync(out.server)
    expect(verifySums(dist)).toContain(`vibase-server-d1-${s.version}.tgz (missing)`)
    writeFileSync(join(dist, 'vibase-other-0.1.0.tgz'), 'x')
    expect(verifySums(dist)).toContain('vibase-other-0.1.0.tgz (extra)')
  })
  it('verifySums flags a tampered SDK tarball', () => {
    const { s, clientDir, serverDir, sdkDir, dist } = built()
    const out = packRelease({ clientDir, serverDir, sdkDir, dist, version: s.version })
    writeFileSync(out.sdk, 'tampered')
    expect(verifySums(dist)).toEqual([`vibase-sdk-${s.version}.tgz (mismatch)`])
  })
})
