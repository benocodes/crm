// [[OPS237]] P1 (the tag check, a matrix) and P2 (the release-asset list).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decideTag, releaseAssets } from './ci.js'
import { ReleaseRefusal } from './errors.js'

describe('the tag check (P1)', () => {
  it('v<version> exactly selects the release path', () => {
    expect(decideTag({ refType: 'tag', refName: 'v0.1.0' }, '0.1.0')).toEqual({ mode: 'release', tag: 'v0.1.0' })
  })
  it('v<another version> refuses, naming the tag and the version', () => {
    expect(() => decideTag({ refType: 'tag', refName: 'v0.2.0' }, '0.1.0')).toThrow(/v0\.2\.0.*0\.1\.0|0\.1\.0.*v0\.2\.0/)
    expect(() => decideTag({ refType: 'tag', refName: 'v0.2.0' }, '0.1.0')).toThrow(ReleaseRefusal)
  })
  it.each(['v1', 'release-0.1.0', '0.1.0', 'v0.1', 'v0.1.0.0', 'V0.1.0', 'v0.1.0 '])('a tag that is not v<semver> (%s) refuses', (name) => {
    expect(() => decideTag({ refType: 'tag', refName: name }, '0.1.0')).toThrow(ReleaseRefusal)
  })
  it('a prerelease or build suffix is not the version: v0.1.0-rc.1 refuses against 0.1.0', () => {
    expect(() => decideTag({ refType: 'tag', refName: 'v0.1.0-rc.1' }, '0.1.0')).toThrow(/0\.1\.0/)
  })
  it('a dispatch run (a branch ref, or none) selects build-only and never the release path', () => {
    expect(decideTag({ refType: 'branch', refName: 'main' }, '0.1.0')).toEqual({ mode: 'build-only' })
    expect(decideTag({}, '0.1.0')).toEqual({ mode: 'build-only' })
  })
})

const roots: string[] = []
afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }) })
const dist = (files: string[]) => {
  const d = mkdtempSync(join(tmpdir(), 'ops237-dist-'))
  roots.push(d)
  for (const f of files) writeFileSync(join(d, f), f)
  return d
}
const GOOD = ['vibase-cli-0.1.0.tgz', 'vibase-server-d1-0.1.0.tgz', 'SHA256SUMS']

describe('the release asset list (P2)', () => {
  it('returns exactly the two tarballs and SHA256SUMS of the version, as paths in dist', () => {
    const d = dist(GOOD)
    expect(releaseAssets(d, '0.1.0')).toEqual(GOOD.map((f) => join(d, f)))
  })
  it('a missing tarball refuses, naming it', () => {
    expect(() => releaseAssets(dist(['vibase-cli-0.1.0.tgz', 'SHA256SUMS']), '0.1.0')).toThrow(/vibase-server-d1-0\.1\.0\.tgz.*missing|missing.*vibase-server-d1-0\.1\.0\.tgz/)
  })
  it('a missing SHA256SUMS refuses', () => {
    expect(() => releaseAssets(dist(GOOD.slice(0, 2)), '0.1.0')).toThrow(/SHA256SUMS/)
  })
  it('an extra file refuses, naming it', () => {
    expect(() => releaseAssets(dist([...GOOD, 'notes.txt']), '0.1.0')).toThrow(/notes\.txt/)
  })
  it('an extra directory refuses', () => {
    const d = dist(GOOD)
    mkdirSync(join(d, 'sub'))
    expect(() => releaseAssets(d, '0.1.0')).toThrow(/sub/)
  })
  it('a tarball of another version refuses (missing the right one, extra the wrong one)', () => {
    const d = dist(['vibase-cli-0.1.0.tgz', 'vibase-server-d1-0.0.9.tgz', 'SHA256SUMS'])
    expect(() => releaseAssets(d, '0.1.0')).toThrow(/vibase-server-d1-0\.0\.9\.tgz/)
  })
})
