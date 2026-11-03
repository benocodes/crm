import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { probeEnvFile } from './env-file.js'

// A throwaway git repo shaped like this one: a root `.env` and `.env.*` ignored, `.env.example` not.
let root: string
const rootEnv = () => join(root, '.env')
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ops87-envfile-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, '.gitignore'), '.env\n.env.*\n!.env.example\n')
  writeFileSync(rootEnv(), 'CLOUDFLARE_API_TOKEN=x\n')
  writeFileSync(join(root, '.env.dev'), 'CLERK_SECRET_KEY=sk_test_x\n')
  writeFileSync(join(root, '.env.example'), 'CLERK_SECRET_KEY=\n')
  mkdirSync(join(root, 'sub'))
  symlinkSync(rootEnv(), join(root, 'sub', 'link.env'))
  symlinkSync(rootEnv(), join(root, '.env.linked'))
})

describe('probeEnvFile (D34)', () => {
  it('defaults to .env.<env> at the repo root, reads it, and says it is ignored', () => {
    const p = probeEnvFile(undefined, 'dev', root, rootEnv())
    expect(p).toMatchObject({ status: 'ok', text: 'CLERK_SECRET_KEY=sk_test_x\n' })
    expect(p.display).toContain('.env.dev')
  })
  it('a relative path resolves against the repo root (pnpm -C moves the working directory)', () => {
    expect(probeEnvFile('.env.dev', 'x', root, rootEnv()).status).toBe('ok')
  })
  it.each<[string, string]>([
    ['.env', 'bare'],
    ['./.env', 'dot-slash'],
    ['sub/../.env', 'dot-dot'],
    ['sub/link.env', 'a symlink to it'],
    ['.env.linked', 'an ignored symlink to it'],
  ])('%s (%s) is refused as the root .env, with no text', (arg, _n) => {
    const p = probeEnvFile(arg, 'x', root, rootEnv())
    expect(p.status).toBe('root-env')
    expect(p.text).toBeUndefined()
  })
  it('an absolute path to the root .env is refused', () => {
    expect(probeEnvFile(rootEnv(), 'x', root, rootEnv()).status).toBe('root-env')
  })
  it('a file git does not ignore is not-ignored, with no text', () => {
    const p = probeEnvFile('.env.example', 'x', root, rootEnv())
    expect(p.status).toBe('not-ignored')
    expect(p.text).toBeUndefined()
  })
  it('a missing file is missing', () => {
    expect(probeEnvFile('.env.nope', 'x', root, rootEnv()).status).toBe('missing')
  })
})
