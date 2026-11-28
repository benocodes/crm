// [[OPS693]] D8: `scripts/prepare-release.mjs` checks the SDK's version beside the other two and prints three publish lines, the SDK first. The script's checks that need git and
// GitHub are not run here; its version rule and its printed lines are the two functions of `scripts/prepare-release-lib.mjs` it calls.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPTS = fileURLToPath(new URL('../../../scripts/', import.meta.url))
const lib = () => import(/* @vite-ignore */ `${SCRIPTS}prepare-release-lib.mjs`) as Promise<any>
const roots: string[] = []
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})
const workspace = (v: { cli: string; server: string; sdk: string }) => {
  const root = mkdtempSync(join(tmpdir(), 'ops693-prep-'))
  roots.push(root)
  for (const [dir, version] of [
    ['cli', v.cli],
    ['server-d1', v.server],
    ['sdk', v.sdk],
  ] as const) {
    mkdirSync(join(root, 'packages', dir), { recursive: true })
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify({ version }))
  }
  return root
}

describe('prepare-release.mjs (D8)', () => {
  it('the version is the one the three packages share', async () => {
    const { releaseVersion } = await lib()
    expect(releaseVersion(workspace({ cli: '0.4.0', server: '0.4.0', sdk: '0.4.0' }))).toBe('0.4.0')
  })
  it('an SDK version that differs refuses, naming all three packages and versions', async () => {
    const { releaseVersion } = await lib()
    const f = () => releaseVersion(workspace({ cli: '0.4.0', server: '0.4.0', sdk: '0.3.0' }))
    for (const re of [/@vibase\/cli 0\.4\.0/, /@vibase\/server-d1 0\.4\.0/, /@vibase\/sdk 0\.3\.0/])
      expect(f).toThrow(re)
  })
  it('the script itself exits 1 with that refusal when run in such a workspace', () => {
    const root = workspace({ cli: '0.4.0', server: '0.4.0', sdk: '0.3.0' })
    const r = spawnSync('node', [join(SCRIPTS, 'prepare-release.mjs'), '--dry-run'], { cwd: root, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/@vibase\/sdk 0\.3\.0/)
  })
  it('prints three publish lines: the SDK first, then the server, then the CLI', async () => {
    const { publishLines } = await lib()
    expect(publishLines('0.4.0')).toEqual([
      'npm publish vibase-sdk-0.4.0.tgz --access public',
      'npm publish vibase-server-d1-0.4.0.tgz --access public',
      'npm publish vibase-cli-0.4.0.tgz --access public',
    ])
  })
})
