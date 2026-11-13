import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { INSTANCE_HELP, runInstance, wranglerBin } from './main.js'
import { cleanup, makeWorld, mkTmp, stagedPackage } from './test-kit.js'

afterEach(cleanup)
const io = (env: Record<string, string | undefined> = {}) => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t), env } }
}

describe('instance entry', () => {
  it('prints help for no command, help and --help, exit 0', async () => {
    for (const argv of [[], ['help'], ['--help']]) {
      const r = io()
      expect(await runInstance(argv, r.io, stagedPackage().dir)).toBe(0)
      expect(r.out.join('')).toBe(INSTANCE_HELP)
    }
    expect(INSTANCE_HELP).toMatch(/vibase-server status --env/)
    expect(INSTANCE_HELP).toMatch(/vibase-server upgrade --env <name> \[--dry-run\] \[--rollback\]/)
    expect(INSTANCE_HELP).toMatch(/wrangler rollback/)
    expect(INSTANCE_HELP).toMatch(/newer schema/)
  })
  it('refuses an unknown command with exit 2', async () => {
    const r = io()
    expect(await runInstance(['bogus'], r.io, stagedPackage().dir)).toBe(2)
    expect(r.err.join('')).toMatch(/unknown command "bogus"/)
  })
  it('OPS240 D21: --version prints vibase-server/<version> (<commit>) from the release.json of the package, exit 0, nothing on stderr', async () => {
    const pkg = stagedPackage()
    const release = JSON.parse(readFileSync(join(pkg.dir, 'release.json'), 'utf8')) as { version: string; commit: string }
    const r = io()
    expect(await runInstance(['--version'], r.io, pkg.dir)).toBe(0)
    expect(r.out.join('')).toBe(`vibase-server/${release.version} (${release.commit})\n`)
    expect(r.err).toEqual([])
  })
  it('OPS240 D21: --version of a directory with no release.json refuses (exit 2) naming it, never prints a made-up version', async () => {
    const r = io()
    const dir = mkTmp()
    expect(await runInstance(['--version'], r.io, dir)).toBe(2)
    expect(r.out).toEqual([])
    expect(r.err.join('')).toContain(dir)
  })
  it('OPS240 D21: the help names the program vibase-server and no longer mentions `vibase instance`', () => {
    expect(INSTANCE_HELP).toMatch(/^vibase-server: /)
    expect(INSTANCE_HELP).not.toMatch(/vibase instance/)
    expect(INSTANCE_HELP).toMatch(/vibase-server setup --env <name> --api-host <host>/)
  })
  it('status with no settings file (real deps) refuses naming the default path, before any network call', async () => {
    const xdg = mkTmp()
    const r = io({ XDG_CONFIG_HOME: xdg, PATH: process.env.PATH })
    expect(await runInstance(['status', '--env', 'demo'], r.io, stagedPackage().dir)).toBe(2)
    expect(r.err.join('')).toContain(join(xdg, 'vibase', 'instances', 'demo.json'))
  })
  it('upgrade with no settings file (real deps) refuses naming the default path, before any network call', async () => {
    const xdg = mkTmp()
    const r = io({ XDG_CONFIG_HOME: xdg, PATH: process.env.PATH })
    expect(await runInstance(['upgrade', '--env', 'demo'], r.io, stagedPackage().dir)).toBe(2)
    expect(r.err.join('')).toContain(join(xdg, 'vibase', 'instances', 'demo.json'))
  })
  it('a package whose wrangler cannot be resolved refuses (exit 2) naming the package, never an internal error', async () => {
    for (const command of ['status', 'upgrade']) {
      const w = makeWorld({ health: () => new Response(JSON.stringify({ version: '0.1.0', status: 'ok' }), { status: 200 }) })
      // The nearest `wrangler` the package sees has no bin: it cannot be run, and nothing is ever spawned.
      const outer = mkTmp('ops234-outer-')
      const pkgDir = join(outer, 'node_modules', 'vibase')
      cpSync(w.pkg.dir, pkgDir, { recursive: true })
      mkdirSync(join(outer, 'node_modules', 'wrangler'), { recursive: true })
      writeFileSync(join(outer, 'node_modules', 'wrangler', 'package.json'), JSON.stringify({ name: 'wrangler', version: '0.0.0' }))
      const r = io({ XDG_CONFIG_HOME: w.config, PATH: process.env.PATH, HOME: w.deps.homedir, CONFIRM_REMOTE: '1' })
      const code = await runInstance([command, '--env', 'demo'], r.io, pkgDir, { fetch: w.deps.fetch })
      expect(code).toBe(2)
      expect(r.err.join('')).toContain(`vibase-server ${command}: `)
      expect(r.err.join('')).toContain(pkgDir)
      expect(r.err.join('')).toMatch(/wrangler/)
    }
  })
  it('resolves the package-own wrangler from a package directory that depends on it', () => {
    const bin = wranglerBin(fileURLToPath(new URL('../..', import.meta.url)))
    expect(bin).toMatch(/wrangler\/bin\/wrangler\.js$/)
    expect(existsSync(bin)).toBe(true)
  })
})
