import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildInstance } from './build.js'
import { cleanup, mkTmp, stagedPackage } from './test-kit.js'

afterEach(cleanup)
describe('D12 the instance bundle', () => {
  it('runs as a standalone ESM file outside the repo: help prints and an unknown command exits 2 (no dynamic-require failure)', async () => {
    const out = join(mkTmp(), 'server.js')
    await buildInstance({ outfile: out })
    // The bundle is a program now (OPS240 D21): it parses its own argv.
    const run = (cmd: string) => spawnSync('node', [out, cmd], { encoding: 'utf8', cwd: mkTmp() })
    expect(run('help').stdout).toMatch(/vibase-server status --env/)
    // an unknown command exits 2; loading the bundle already ran every module's top level, jsonc-parser's included
    expect(run('nope').status).toBe(2)
  })
})

describe('OPS240 D21 the server program as bundled (cli/server.js in a package directory)', () => {
  const installed = async () => {
    const pkg = stagedPackage()
    const file = join(pkg.dir, 'cli', 'server.js')
    mkdirSync(join(pkg.dir, 'cli'), { recursive: true })
    await buildInstance({ outfile: file })
    return { pkg, file, release: JSON.parse(readFileSync(join(pkg.dir, 'release.json'), 'utf8')) as { version: string; commit: string } }
  }
  it('is a node script with a shebang (it is the package bin)', async () => {
    const { file } = await installed()
    expect(readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
  })
  it('--version prints vibase-server/<version> (<commit>) from the release.json beside the package', async () => {
    const { file, release } = await installed()
    expect(execFileSync('node', [file, '--version'], { encoding: 'utf8', cwd: mkTmp() })).toBe(`vibase-server/${release.version} (${release.commit})\n`)
  })
  it('--help lists the three commands under vibase-server, exit 0; an unknown command exits 2 with the help', async () => {
    const { file } = await installed()
    const help = spawnSync('node', [file, '--help'], { encoding: 'utf8', cwd: mkTmp() })
    expect(help.status).toBe(0)
    for (const c of ['status', 'upgrade', 'setup']) expect(help.stdout).toContain(`vibase-server ${c} --env`)
    const bad = spawnSync('node', [file, 'bogus'], { encoding: 'utf8', cwd: mkTmp() })
    expect(bad.status).toBe(2)
    expect(bad.stderr).toMatch(/unknown command "bogus"/)
  })
  it('the package-relative paths still resolve when the file is copied with its package elsewhere', async () => {
    const { pkg, file, release } = await installed()
    const copy = mkTmp()
    cpSync(pkg.dir, copy, { recursive: true })
    expect(execFileSync('node', [join(copy, 'cli', 'server.js'), '--version'], { encoding: 'utf8', cwd: mkTmp() })).toBe(`vibase-server/${release.version} (${release.commit})\n`)
    void file
  })
})
