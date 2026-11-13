// [[OPS237]] D1/D25: the version source (the two workspace packages), the changesets config, and `changeset version` over a scratch copy.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ReleaseRefusal } from './errors.js'
import { readReleaseVersion } from './version.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d }

const workspace = (cli: Record<string, unknown> | null, server: Record<string, unknown> | null) => {
  const root = tmp('ops237-ver-')
  for (const [dir, pkg] of [['cli', cli], ['server-d1', server]] as const) {
    if (pkg === null) continue
    mkdirSync(join(root, 'packages', dir), { recursive: true })
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify(pkg))
  }
  return root
}

describe('the version reader (D1)', () => {
  it('returns the version both workspace packages share', () => {
    expect(readReleaseVersion(workspace({ name: '@vibase/cli', version: '0.3.1' }, { name: '@vibase/server-d1', version: '0.3.1' }))).toBe('0.3.1')
  })
  it('accepts a prerelease version both share', () => {
    expect(readReleaseVersion(workspace({ version: '0.4.0-rc.0' }, { version: '0.4.0-rc.0' }))).toBe('0.4.0-rc.0')
  })
  it('refuses when a workspace package has no version, naming it', () => {
    expect(() => readReleaseVersion(workspace({ name: '@vibase/cli' }, { version: '0.1.0' }))).toThrow(/packages\/cli\/package\.json/)
    expect(() => readReleaseVersion(workspace({ version: '0.1.0' }, { version: '' }))).toThrow(/packages\/server-d1\/package\.json/)
    expect(() => readReleaseVersion(workspace({ name: '@vibase/cli' }, { version: '0.1.0' }))).toThrow(ReleaseRefusal)
  })
  it('refuses when a package.json is missing', () => {
    expect(() => readReleaseVersion(workspace(null, { version: '0.1.0' }))).toThrow(ReleaseRefusal)
  })
  it('refuses when the two differ, naming both packages and both versions', () => {
    const f = () => readReleaseVersion(workspace({ version: '0.1.0' }, { version: '0.1.1' }))
    expect(f).toThrow(/0\.1\.0/)
    expect(f).toThrow(/0\.1\.1/)
    expect(f).toThrow(/packages\/cli/)
    expect(f).toThrow(/packages\/server-d1/)
  })
  it('the real repository has one version in both packages', () => {
    expect(readReleaseVersion(REPO)).toMatch(/^\d+\.\d+\.\d+/)
  })
})

const pkgDirs = (root: string) => readdirSync(join(root, 'packages')).filter((d) => existsSync(join(root, 'packages', d, 'package.json')))
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, any>
const workspaceNames = (root: string) => pkgDirs(root).map((d) => json(join(root, 'packages', d, 'package.json')).name as string).sort()

/** What is wrong with the changesets configuration of a repository root ([[OPS237]] D25). */
export function configProblems(root: string): string[] {
  const out: string[] = []
  const c = json(join(root, '.changeset', 'config.json'))
  if (JSON.stringify(c.fixed) !== JSON.stringify([['@vibase/cli', '@vibase/server-d1']])) out.push(`fixed is ${JSON.stringify(c.fixed)}, expected exactly one group of @vibase/cli and @vibase/server-d1`)
  const names = workspaceNames(root)
  const others = names.filter((n) => n !== '@vibase/cli' && n !== '@vibase/server-d1')
  if (others.length !== 11) out.push(`expected 11 other workspace packages, found ${others.length}`)
  const ignore = [...(c.ignore ?? [])].sort()
  if (JSON.stringify(ignore) !== JSON.stringify(others)) out.push(`ignore is ${JSON.stringify(ignore)}, expected the other workspace packages ${JSON.stringify(others)}`)
  if (JSON.stringify(c.privatePackages) !== JSON.stringify({ version: true, tag: false })) out.push('privatePackages must be { version: true, tag: false }')
  if (c.baseBranch !== 'main') out.push('baseBranch must be main')
  if (c.commit !== false) out.push('commit must be false')
  for (const d of ['cli', 'server-d1']) if (json(join(root, 'packages', d, 'package.json')).private !== true) out.push(`packages/${d} must be private: true`)
  return out
}

/** Copies the workspace manifests and the changesets config to a scratch git repository, adds one fixture changeset for `@vibase/server-d1`, runs `changeset version`, returns each package.json's version afterwards and the files that changed. */
export function scratchVersion(mutate: (c: Record<string, any>) => void = () => {}): { versions: Record<string, string | undefined>; changed: string[] } {
  const dir = tmp('ops237-scratch-')
  cpSync(join(REPO, '.changeset'), join(dir, '.changeset'), { recursive: true })
  for (const f of ['package.json', 'pnpm-workspace.yaml']) cpSync(join(REPO, f), join(dir, f))
  for (const d of pkgDirs(REPO)) {
    mkdirSync(join(dir, 'packages', d), { recursive: true })
    cpSync(join(REPO, 'packages', d, 'package.json'), join(dir, 'packages', d, 'package.json'))
  }
  const cfg = json(join(dir, '.changeset', 'config.json'))
  mutate(cfg)
  writeFileSync(join(dir, '.changeset', 'config.json'), JSON.stringify(cfg))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'pipe' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'scratch')
  writeFileSync(join(dir, '.changeset', 'fixture.md'), '---\n"@vibase/server-d1": patch\n---\n\nfixture\n')
  execFileSync(join(REPO, 'node_modules', '.bin', 'changeset'), ['version'], { cwd: dir, stdio: 'pipe', env: { ...process.env, CI: '1' } })
  const changed = git('status', '--porcelain', '-uall').toString().split('\n').filter(Boolean).map((l) => l.slice(3)).filter((f) => !f.startsWith('.changeset/'))
  const versions: Record<string, string | undefined> = {}
  for (const d of pkgDirs(dir)) { const p = json(join(dir, 'packages', d, 'package.json')); versions[p.name] = p.version }
  return { versions, changed }
}

describe('the changesets configuration (D25)', () => {
  it('has the fixed group of exactly the two names, the other eleven ignored, both packages private', () => {
    expect(configProblems(REPO)).toEqual([])
  })
  it('mutation: private: false on one package is reported', () => {
    const root = tmp('ops237-cfg-')
    cpSync(join(REPO, '.changeset'), join(root, '.changeset'), { recursive: true })
    for (const d of pkgDirs(REPO)) {
      mkdirSync(join(root, 'packages', d), { recursive: true })
      const p = json(join(REPO, 'packages', d, 'package.json'))
      if (d === 'cli') p.private = false
      writeFileSync(join(root, 'packages', d, 'package.json'), JSON.stringify(p))
    }
    expect(configProblems(root).join('\n')).toMatch(/packages\/cli must be private/)
  })
})

describe('changeset version in a scratch copy (D25)', () => {
  it('one changeset on @vibase/server-d1 bumps both packages together and touches no other package.json', () => {
    const { versions, changed } = scratchVersion()
    expect(versions['@vibase/server-d1']).toBe('0.1.1')
    expect(versions['@vibase/cli']).toBe('0.1.1')
    expect(changed.filter((f) => f.endsWith('package.json')).sort()).toEqual(['packages/cli/package.json', 'packages/server-d1/package.json'])
    expect(changed.filter((f) => !f.endsWith('package.json')).sort()).toEqual(['packages/cli/CHANGELOG.md', 'packages/server-d1/CHANGELOG.md'])
  })
  it('mutation: with @vibase/cli dropped from the fixed group the client is left behind (so the check above would be red)', () => {
    const { versions } = scratchVersion((c) => { c.fixed = [['@vibase/server-d1']] })
    expect(versions['@vibase/server-d1']).toBe('0.1.1')
    expect(versions['@vibase/cli']).toBe('0.1.0')
  })
})
