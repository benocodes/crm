import { appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { compareSemver, parseSemver, runGate } from './gate.js'
import { captureHealthBody, cleanup, NO_TRACKER_JSON, trackerJson, validSettings, makeWorld, type World, type WorldOptions } from './test-kit.js'
import { InstanceRefusal } from './types.js'

afterEach(cleanup)
let HEALTH: Record<string, any>
beforeAll(async () => { HEALTH = await captureHealthBody() })
const healthRes = (over: Record<string, unknown> = {}, status = 200) => () => new Response(JSON.stringify({ ...HEALTH, ...over }), { status, headers: { 'content-type': 'application/json' } })
const gate = (w: World, extra: { settingsPath?: string; secretsPath?: string } = {}) => runGate({ envName: 'demo', ...extra }, w.deps)
const world = (o: WorldOptions = {}) => makeWorld({ health: healthRes({ version: '0.1.0' }), ...o })
const calls = (w: World) => ({ fetch: w.fetchUrls.length, wrangler: w.wrangler.length, tmp: readdirSync(w.tmpRoot) })
const refusal = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(() => null, (x: unknown) => x)
  expect(e).toBeInstanceOf(InstanceRefusal)
  expect((e as Error).message).toMatch(re)
}

describe('the health fixture is the real compose.ts body', () => {
  it('has the fields the gate reads', () => {
    expect(HEALTH).toMatchObject({ status: 'ok', version: expect.any(String), commit: expect.any(String), migrations: { status: expect.any(String) } })
  })
})

describe('semver', () => {
  it('parses release and prerelease versions and refuses shas and dev', () => {
    expect(parseSemver('0.1.0')).toEqual([0, 1, 0, ''])
    expect(parseSemver('1.2.3-rc.1')).toEqual([1, 2, 3, 'rc.1'])
    for (const v of ['dev', 'abc1234', 'ab10bb80d4c2e1f0a9b8c7d6e5f4a3b2c1d0e9f8', '1.2', 'v1.2.3', '']) expect(parseSemver(v)).toBeNull()
  })
  it('orders by number, a prerelease before its release', () => {
    expect(compareSemver('0.1.0', '0.2.0')).toBeLessThan(0)
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
  })
})

describe('D14 gate matrix', () => {
  it('passes with equal versions and current migrations', async () => {
    const w = world()
    const g = await gate(w)
    expect(g.live.version).toBe('0.1.0')
    expect(g.applied).toEqual(w.pkg.migrations)
    expect(g.pending).toEqual([])
    expect(g.notes).toEqual([])
    expect(w.fetchUrls).toEqual(['https://api.demo.invalid/health'])
    expect(calls(w).tmp).toEqual([])
  })

  it('(a) a tampered installed file is refused before any network call or child process, even with no settings file', async () => {
    const w = world({ settings: null })
    appendFileSync(join(w.pkg.dir, 'worker', 'worker.js'), 'x')
    await refusal(gate(w), /worker\/worker\.js \(mismatch\)/)
    expect(calls(w)).toEqual({ fetch: 0, wrangler: 0, tmp: [] })
  })
  it('(a) a tampered cli/instance.js is refused too (D12: verify covers it)', async () => {
    const w = world()
    appendFileSync(join(w.pkg.dir, 'cli', 'instance.js'), 'x')
    await refusal(gate(w), /cli\/instance\.js \(mismatch\)/)
    expect(calls(w)).toEqual({ fetch: 0, wrangler: 0, tmp: [] })
  })

  it('(b) invalid settings are refused before any network call', async () => {
    const w = world({ settings: validSettings({ extra: 1 }) })
    await refusal(gate(w), /extra/)
    expect(calls(w)).toEqual({ fetch: 0, wrangler: 0, tmp: [] })
  })
  it('(b) a group-readable secrets file is refused before any network call', async () => {
    const w = world({ secretsMode: 0o640 })
    await refusal(gate(w), /demo\.env/)
    expect(calls(w)).toEqual({ fetch: 0, wrangler: 0, tmp: [] })
  })

  it('(c) an unreachable /health names the URL and starts no child process', async () => {
    const w = makeWorld({ health: () => { throw new TypeError('fetch failed') } })
    await refusal(gate(w), /https:\/\/api\.demo\.invalid\/health/)
    expect(calls(w)).toEqual({ fetch: 1, wrangler: 0, tmp: [] })
  })
  it.each([
    ['a 503', () => new Response('{"status":"unavailable"}', { status: 503 })],
    ['a non-vault 200 (html)', () => new Response('<html>hello</html>', { status: 200 })],
    ['a 200 json without a version string', () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })],
    ['a 200 with a numeric version', () => new Response(JSON.stringify({ ...HEALTH, version: 3 }), { status: 200 })],
  ])('(c) %s fails the health check', async (_n, health) => {
    const w = makeWorld({ health })
    await refusal(gate(w), /https:\/\/api\.demo\.invalid\/health/)
    expect(calls(w)).toEqual({ fetch: 1, wrangler: 0, tmp: [] })
  })

  it('(d) an applied migration the release lacks refuses with the D14 message, naming it', async () => {
    const w = world()
    const w2 = world({ runner: () => ({ status: 0, stdout: trackerJson([...w.pkg.migrations, '9999_from_the_future.sql']), stderr: '' }) })
    await refusal(gate(w2), /the database has migrations this release does not know: install a newer release.*9999_from_the_future\.sql/s)
    expect(readdirSync(w2.tmpRoot)).toEqual([])
  })

  it('(e) a newer semver live version refuses, naming both versions', async () => {
    const w = makeWorld({ health: healthRes({ version: '9.0.0' }) })
    await refusal(gate(w), /9\.0\.0.*0\.1\.0.*newer|newer.*9\.0\.0/s)
    expect(readdirSync(w.tmpRoot)).toEqual([])
  })

  it.each(['abc1234', 'dev', 'ab10bb80d4c2e1f0a9b8c7d6e5f4a3b2c1d0e9f8'])('(f) a non-semver live version %s proceeds with a note', async (version) => {
    const w = makeWorld({ health: healthRes({ version }) })
    const g = await gate(w)
    expect(g.live.version).toBe(version)
    expect(g.notes.join('\n')).toMatch(new RegExp(`${version}.*not a release version`))
  })

  it('(g) no tracker table: the gate passes, applied is null and every package migration is pending', async () => {
    const w = world({ runner: () => ({ status: 1, stdout: NO_TRACKER_JSON, stderr: '' }) })
    const g = await gate(w)
    expect(g.applied).toBeNull()
    expect(g.pending).toEqual(w.pkg.migrations)
    expect(readdirSync(w.tmpRoot)).toEqual([])
  })

  it('an older live version passes the gate (status prints the plan)', async () => {
    const w = world({ health: healthRes({ version: '0.0.9' }), runner: () => ({ status: 0, stdout: trackerJson(['0001_a.sql']), stderr: '' }) })
    const g = await gate(w)
    expect(g.pending).toEqual(['0002_b.sql'])
  })

  it('a wrangler failure is a refusal that leaves no temp directory', async () => {
    const w = world({ runner: () => ({ status: 1, stdout: '', stderr: 'Authentication error [code: 10000]' }) })
    await refusal(gate(w), /wrangler d1 execute failed \(exit 1\).*Authentication error/s)
    expect(readdirSync(w.tmpRoot)).toEqual([])
  })

  it('honours --settings and --secrets-file paths', async () => {
    const w = world()
    const g = await gate(w, { settingsPath: w.settingsPath, secretsPath: w.secretsPath })
    expect(g.settingsPath).toBe(w.settingsPath)
  })
})
