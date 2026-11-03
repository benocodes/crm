import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The root `pnpm vibase` wrapper ([[API6]] D12). It is copied into a throwaway repo next to a fake CLI entry, so the
// tests prove the wrapper (cwd, argv, stdin, exit code, missing dist) and not the real CLI.
const WRAPPER = new URL('./vibase.mjs', import.meta.url).pathname
let root: string
let callerDir: string
const FAKE_CLI = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'exit') process.exit(Number(args[1]))
if (args[0] === 'cat') { process.stdout.write(readFileSync(0)); process.exit(0) }
if (args[0] === 'copy') { writeFileSync(args[2], readFileSync(args[1].slice(1))); process.exit(0) }
if (args[0] === 'err') { process.stderr.write('to-stderr'); process.exit(0) }
process.stdout.write(JSON.stringify({ cwd: process.cwd(), args }))
`

const run = (args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string; wrapper?: string } = {}) =>
  spawnSync(process.execPath, [opts.wrapper ?? join(root, 'scripts/vibase.mjs'), ...args], {
    cwd: opts.cwd ?? root,
    env: { ...process.env, INIT_CWD: undefined, ...opts.env },
    input: opts.input,
    encoding: 'utf8',
  })

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vibase-wrapper-')))
  callerDir = join(root, 'elsewhere')
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'packages/cli/dist'), { recursive: true })
  mkdirSync(callerDir)
  copyFileSync(WRAPPER, join(root, 'scripts/vibase.mjs'))
  writeFileSync(join(root, 'packages/cli/dist/vibase.js'), FAKE_CLI)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('root vibase wrapper', () => {
  it('runs the CLI in INIT_CWD, not the repo root', () => {
    const r = run(['a'], { env: { INIT_CWD: callerDir } })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).cwd).toBe(callerDir)
  })
  it('falls back to the current directory without INIT_CWD', () => {
    expect(JSON.parse(run(['a'], { cwd: callerDir }).stdout).cwd).toBe(callerDir)
  })
  it('resolves a relative @file and --output against INIT_CWD', () => {
    writeFileSync(join(callerDir, 'in.json'), '{"x":1}')
    const r = run(['copy', '@in.json', 'out.json'], { env: { INIT_CWD: callerDir } })
    expect(r.status).toBe(0)
    expect(readFileSync(join(callerDir, 'out.json'), 'utf8')).toBe('{"x":1}')
    expect(existsSync(join(root, 'out.json'))).toBe(false)
  })
  it('forwards argv unchanged, including flags and spaces', () => {
    const args = ['contacts', 'create', '--name', 'Ada Lovelace', '--data', '{"a":"b c"}', '--', '-x']
    expect(JSON.parse(run(args, { env: { INIT_CWD: callerDir } }).stdout).args).toEqual(args)
  })
  it.each([0, 1, 2, 7])('forwards exit code %i', (code) => {
    expect(run(['exit', String(code)], { env: { INIT_CWD: callerDir } }).status).toBe(code)
  })
  it('passes stdin through and never adds output of its own', () => {
    const key = 'sk_test_SECRET_KEY_123'
    const r = run(['cat'], { input: key, env: { INIT_CWD: callerDir } })
    expect(r.stdout).toBe(key)
    expect(r.stderr).toBe('')
  })
  it('forwards stderr', () => {
    expect(run(['err'], { env: { INIT_CWD: callerDir } }).stderr).toBe('to-stderr')
  })
  it('never prints a key from the environment', () => {
    const r = run(['a'], { env: { INIT_CWD: callerDir, VIBASE_API_KEY: 'sk_live_NEVER_PRINT' } })
    expect(r.stdout + r.stderr).not.toContain('sk_live_NEVER_PRINT')
  })

  describe('dist missing', () => {
    let bare: string
    let bin: string
    beforeAll(() => {
      bare = realpathSync(mkdtempSync(join(tmpdir(), 'vibase-wrapper-bare-')))
      mkdirSync(join(bare, 'scripts'))
      mkdirSync(join(bare, 'packages/cli'), { recursive: true })
      copyFileSync(WRAPPER, join(bare, 'scripts/vibase.mjs'))
      bin = join(bare, 'bin')
      mkdirSync(bin)
    })
    afterAll(() => rmSync(bare, { recursive: true, force: true }))
    const fakePnpm = (body: string) => {
      writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, 'pnpm'), 0o755)
    }
    const env = () => ({ PATH: `${bin}:${process.env.PATH}`, INIT_CWD: callerDir })

    it('builds first, says so on stderr, then runs the CLI', () => {
      fakePnpm(`mkdir -p ${bare}/packages/cli/dist && printf '%s' "process.stdout.write('built-ok')" > ${bare}/packages/cli/dist/vibase.js`)
      const r = run(['a'], { wrapper: join(bare, 'scripts/vibase.mjs'), env: env() })
      expect(r.stderr).toMatch(/building/i)
      expect(r.stdout).toBe('built-ok')
      expect(r.status).toBe(0)
      rmSync(join(bare, 'packages/cli/dist'), { recursive: true })
    })
    it('exits 2 with the one-line fix when the build fails', () => {
      fakePnpm('exit 1')
      const r = run(['a'], { wrapper: join(bare, 'scripts/vibase.mjs'), env: env() })
      expect(r.status).toBe(2)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('pnpm -C packages/cli build')
    })
  })
})
