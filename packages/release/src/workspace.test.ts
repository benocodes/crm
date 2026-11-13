import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clientPackageJson, serverPackageJson } from './stage.js'

// OPS262 D1, D2: every workspace package is @vibase/<directory>; every one stays private (only the two generated release
// package.json files are ever published); the published names equal the workspace names, and the published package.json files
// depend on no @vibase/* package.
const PACKAGES = new URL('../../', import.meta.url).pathname
const workspace = readdirSync(PACKAGES)
  .filter((d) => existsSync(join(PACKAGES, d, 'package.json')))
  .map((d) => ({ dir: d, pkg: JSON.parse(readFileSync(join(PACKAGES, d, 'package.json'), 'utf8')) as { name: string; private?: boolean; dependencies?: Record<string, string> } }))

describe('OPS262 workspace package names', () => {
  it('finds the 13 workspace packages', () => {
    expect(workspace.map((w) => w.dir).sort()).toEqual(['api', 'approvals-app', 'auth', 'cli', 'db', 'docs', 'release', 'server-d1', 'server-postgres', 'storage', 'storage-d1', 'storage-postgres', 'webhook-receiver-example'])
  })
  it('every package is named @vibase/<directory>', () => {
    expect(workspace.map((w) => [w.dir, w.pkg.name])).toEqual(workspace.map((w) => [w.dir, `@vibase/${w.dir}`]))
  })
  it('every workspace package is private: true, so none can be published under the @vibase scope', () => {
    expect(workspace.filter((w) => w.pkg.private !== true).map((w) => w.dir)).toEqual([])
  })
  it('the published package names equal the workspace names of cli and server-d1', () => {
    const byDir = Object.fromEntries(workspace.map((w) => [w.dir, w.pkg.name]))
    expect(clientPackageJson('1.2.3').name).toBe(byDir.cli)
    expect(serverPackageJson('1.2.3', '4.5.6').name).toBe(byDir['server-d1'])
  })
  it('neither published package.json depends on any @vibase/* package', () => {
    for (const p of [clientPackageJson('1.2.3'), serverPackageJson('1.2.3', '4.5.6')]) {
      const deps = Object.keys({ ...(p.dependencies as object), ...(p.devDependencies as object), ...(p.peerDependencies as object), ...(p.optionalDependencies as object) })
      expect(deps.filter((d) => d.startsWith('@vibase/') || d.startsWith('@vault/'))).toEqual([])
    }
  })
})
