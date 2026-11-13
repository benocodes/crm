import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { INSTANCE_HELP, runInstance, wranglerBin } from './main.js'
import { cleanup, mkTmp, stagedPackage } from './test-kit.js'

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
    expect(INSTANCE_HELP).toMatch(/vibase instance status --env/)
  })
  it('refuses an unknown command with exit 2', async () => {
    const r = io()
    expect(await runInstance(['upgrade'], r.io, stagedPackage().dir)).toBe(2)
    expect(r.err.join('')).toMatch(/unknown command "upgrade"/)
  })
  it('status with no settings file (real deps) refuses naming the default path, before any network call', async () => {
    const xdg = mkTmp()
    const r = io({ XDG_CONFIG_HOME: xdg, PATH: process.env.PATH })
    expect(await runInstance(['status', '--env', 'demo'], r.io, stagedPackage().dir)).toBe(2)
    expect(r.err.join('')).toContain(join(xdg, 'vibase', 'instances', 'demo.json'))
  })
  it('resolves the package-own wrangler from a package directory that depends on it', () => {
    const bin = wranglerBin(fileURLToPath(new URL('../..', import.meta.url)))
    expect(bin).toMatch(/wrangler\/bin\/wrangler\.js$/)
    expect(existsSync(bin)).toBe(true)
  })
})
