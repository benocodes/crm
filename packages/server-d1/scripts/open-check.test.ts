import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyPackages, openManifest, productionTsconfig, type PackageJson } from './open-check.js'

const REPO = ['api', 'db', 'server-d1', 'server-postgres', 'storage', 'storage-d1', 'storage-postgres']
const apiManifest = (): PackageJson => JSON.parse(readFileSync(new URL('../../api/package.json', import.meta.url), 'utf-8'))

describe('open-check pure parts', () => {
  it("classifies the repo's packages", () => {
    const { open, enterprise } = classifyPackages(REPO)
    expect([...open].sort()).toEqual(['api', 'server-d1', 'storage', 'storage-d1'])
    expect([...enterprise].sort()).toEqual(['db', 'server-postgres', 'storage-postgres'])
  })
  it('refuses an unclassified package', () => {
    expect(() => classifyPackages([...REPO, 'cli'])).toThrow('unclassified package: cli')
  })
  it('strips enterprise devDependencies', () => {
    const before = apiManifest()
    expect(before.devDependencies).toHaveProperty('@vault/db')
    const after = openManifest(before)
    expect(after.devDependencies).not.toHaveProperty('@vault/db')
    expect(after.devDependencies).not.toHaveProperty('@vault/storage-postgres')
    expect(after.devDependencies).toHaveProperty('@vault/storage-d1')
    expect(after.dependencies).toEqual(before.dependencies)
    expect(after.exports).toEqual(before.exports)
  })
  it('refuses an enterprise production dependency', () => {
    expect(() => openManifest({ name: 'x', dependencies: { pg: '8.23.1' } })).toThrow('x depends on enterprise package pg in dependencies')
  })
  it('refuses a workspace enterprise package in dependencies', () => {
    expect(() => openManifest({ name: 'x', dependencies: { '@vault/db': 'workspace:*' } })).toThrow('x depends on enterprise package @vault/db in dependencies')
  })
  it('production tsconfig', () => {
    expect(productionTsconfig()).toEqual({ extends: './tsconfig.json', exclude: ['**/*.test.ts', '**/*.typecheck.ts', '**/test/**', 'vitest.config.ts'] })
  })
})
