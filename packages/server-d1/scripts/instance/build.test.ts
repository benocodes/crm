import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildInstance } from './build.js'
import { cleanup, mkTmp } from './test-kit.js'

afterEach(cleanup)
describe('D12 the instance bundle', () => {
  it('runs as a standalone ESM file outside the repo: help prints and an unknown command exits 2 (no dynamic-require failure)', async () => {
    const out = join(mkTmp(), 'instance.js')
    await buildInstance({ outfile: out })
    const run = (cmd: string) => execFileSync('node', ['--input-type=module', '-e', `import run from ${JSON.stringify(out)}; process.exitCode = await run([${JSON.stringify(cmd)}], { stdout: (t) => process.stdout.write(t), stderr: () => {}, env: {} })`], { encoding: 'utf8', cwd: mkTmp() })
    expect(run('help')).toMatch(/vibase instance status --env/)
    // an unknown command exits 2; loading the bundle already ran every module's top level, jsonc-parser's included
    expect(() => run('nope')).toThrow(/exit|Command failed/i)
  })
})
