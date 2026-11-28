import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { run } from './cli.js'

// DX604 D2, D7: the command's entry, driven in-process.
const SDK = fileURLToPath(new URL('../../', import.meta.url))
const GENERATED = join(SDK, 'src/generated')
const SCHEMA = fileURLToPath(new URL('./fixtures/workspace.schema.json', import.meta.url))
const scratch = () => mkdtempSync(join(tmpdir(), 'dx604-'))
const files = (dir: string) => readdirSync(dir).sort()
const mtimes = () => Object.fromEntries(files(GENERATED).map((f) => [f, statSync(join(GENERATED, f)).mtimeMs]))

describe('DX604 D2 command', () => {
  it('with no source regenerates the built-ins into the built-in directory, byte-identical to the committed files', async () => {
    const dir = scratch()
    const r = await run([], { builtInDir: dir })
    expect(r.code).toBe(0)
    expect(files(dir)).toEqual(['operations.ts', 'types.ts'])
    for (const f of files(dir))
      expect(readFileSync(join(dir, f), 'utf8') === readFileSync(join(GENERATED, f), 'utf8')).toBe(true)
  }, 120_000)

  it('DX694 D7, P2: --url is an unknown flag, refused with the usage error and exit 2, before any fetch, writing nothing', async () => {
    const out = scratch()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch must not be called'))
    try {
      for (const argv of [
        ['--url', 'https://a.example', '--out', out],
        ['--url', 'https://a.example', '--schema', SCHEMA, '--out', out],
      ]) {
        const r = await run(argv)
        expect(r.code).toBe(2)
        expect(r.stderr).toMatch(/url/)
        expect(r.stderr).toMatch(/usage:/)
        expect(r.stderr).not.toMatch(/fetch must not be called/)
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
    expect(files(out)).toEqual([])
  })

  it('with a source and no --out is refused', async () => {
    const r = await run(['--schema', SCHEMA])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/--out/)
  })

  it('refuses an --out that is the package own src/generated, absolute or relative, and writes nothing', async () => {
    const before = mtimes()
    for (const [out, initCwd] of [
      [GENERATED, undefined],
      [`${GENERATED}/`, undefined],
      ['src/generated', SDK],
      ['../generated', join(SDK, 'src/generate')],
    ] as const) {
      const r = await run(['--schema', SCHEMA, '--out', out], { ...(initCwd ? { initCwd } : {}), cwd: tmpdir() })
      expect(r.code, `${out} from ${initCwd}`).not.toBe(0)
      expect(r.stderr).toMatch(/src\/generated/)
    }
    expect(mtimes()).toEqual(before)
  })

  it('resolves a relative --schema and --out against INIT_CWD (the option, then the environment), not the cwd', async () => {
    const base = scratch()
    mkdirSync(join(base, 'in'))
    writeFileSync(join(base, 'in/s.json'), readFileSync(SCHEMA))
    const r = await run(['--schema', './in/s.json', '--out', './out/vibase'], { initCwd: base, cwd: tmpdir() })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(files(join(base, 'out/vibase'))).toEqual(['operations.ts', 'types.ts'])

    const saved = process.env.INIT_CWD
    process.env.INIT_CWD = base
    try {
      const again = await run(['--schema', './in/s.json', '--out', './out/env'], { cwd: tmpdir() })
      expect(again.code, again.stderr).toBe(0)
      expect(files(join(base, 'out/env'))).toEqual(['operations.ts', 'types.ts'])
      for (const f of ['operations.ts', 'types.ts'])
        expect(
          readFileSync(join(base, 'out/env', f), 'utf8') === readFileSync(join(base, 'out/vibase', f), 'utf8'),
        ).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.INIT_CWD
      else process.env.INIT_CWD = saved
    }
  }, 120_000)

  it('refuses an invalid schema file with its rule and writes nothing', async () => {
    const base = scratch()
    writeFileSync(join(base, 'bad.json'), JSON.stringify({ version: 1, define: { projects: { fields: {} } } }))
    const r = await run(['--schema', 'bad.json', '--out', 'out'], { initCwd: base })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('key_suffix')
    expect(() => readdirSync(join(base, 'out'))).toThrow()
  })

  it('refuses an unknown flag', async () => {
    const r = await run(['--nope'])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/nope/)
  })
})
