// [[OPS709]] D7: `release:check`'s arguments (zero or three tarballs) and the SHA256SUMS step over all three.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECK_USAGE, CheckUsageError, resolveCheckArgs, verifyBesideSums } from './check-lib.js'
import { ReleaseRefusal } from './errors.js'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('D7 arguments: zero or three tarballs', () => {
  it('zero arguments default all three to dist/vibase-<name>-<version>.tgz', () => {
    expect(resolveCheckArgs([], '/d', '1.2.3')).toEqual({
      client: '/d/vibase-cli-1.2.3.tgz',
      server: '/d/vibase-server-d1-1.2.3.tgz',
      sdk: '/d/vibase-sdk-1.2.3.tgz',
    })
  })
  it('three arguments are cli, server, sdk in that order', () => {
    expect(resolveCheckArgs(['a.tgz', 'b.tgz', 'c.tgz'], '/d', '1.2.3')).toEqual({
      client: 'a.tgz',
      server: 'b.tgz',
      sdk: 'c.tgz',
    })
  })
  it.each([1, 2, 4])('%i arguments are refused with the usage line', (n) => {
    const args = Array.from({ length: n }, (_, i) => `t${i}.tgz`)
    expect(() => resolveCheckArgs(args, '/d', '1.2.3')).toThrow(CheckUsageError)
    expect(() => resolveCheckArgs(args, '/d', '1.2.3')).toThrow(CHECK_USAGE)
  })
  it('the script refuses two arguments with the usage line and exit 2, before any work', () => {
    const r = spawnSync('pnpm', ['exec', 'tsx', 'scripts/check.ts', 'one.tgz', 'two.tgz'], {
      cwd: PKG,
      encoding: 'utf8',
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(CHECK_USAGE)
    expect(r.stdout).not.toContain('ok')
  })
})

describe('D7 sums: SHA256SUMS beside the tarballs is verified over all three', () => {
  function dist(sdkLineHash?: string) {
    const d = mkdtempSync(join(tmpdir(), 'ops709-sums-'))
    dirs.push(d)
    const files = {
      'vibase-cli-1.0.0.tgz': 'cli',
      'vibase-server-d1-1.0.0.tgz': 'server',
      'vibase-sdk-1.0.0.tgz': 'sdk',
    }
    for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), text)
    writeFileSync(
      join(d, 'SHA256SUMS'),
      Object.entries(files)
        .map(([f, text]) => `${f === 'vibase-sdk-1.0.0.tgz' && sdkLineHash ? sdkLineHash : sha(text)}  ${f}`)
        .join('\n') + '\n',
    )
    return {
      client: join(d, 'vibase-cli-1.0.0.tgz'),
      server: join(d, 'vibase-server-d1-1.0.0.tgz'),
      sdk: join(d, 'vibase-sdk-1.0.0.tgz'),
    }
  }
  it('right sums: the log line names three tarballs', () => {
    expect(verifyBesideSums(dist())).toMatch(/SHA256SUMS ok: .*three tarballs/)
  })
  it('an SDK line that does not match the SDK tarball is refused, naming that tarball', () => {
    const t = dist('0'.repeat(64))
    expect(() => verifyBesideSums(t)).toThrow(ReleaseRefusal)
    expect(() => verifyBesideSums(t)).toThrow(/vibase-sdk-1\.0\.0\.tgz \(mismatch\)/)
  })
  it('tarballs in different directories, or no SHA256SUMS: nothing is verified', () => {
    const t = dist()
    expect(verifyBesideSums({ ...t, sdk: '/elsewhere/vibase-sdk-1.0.0.tgz' })).toBeNull()
  })
})
