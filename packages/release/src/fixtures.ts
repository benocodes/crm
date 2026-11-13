// Test helper: a small valid source set for `stageRelease`, in a fresh temp directory.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, type ManifestInput } from './manifest.js'
import type { StageInput } from './stage.js'

export const BASE_SOURCE = `{
  // comment
  "name": "vault",
  "main": "src/worker.ts",
  "compatibility_date": "2026-07-30",
  "d1_databases": [{ "binding": "DB", "database_name": "vault", "database_id": "00000000-0000-0000-0000-000000000000", "migrations_dir": "../storage-d1/migrations" }],
  "assets": { "directory": "./dist/assets", "binding": "ASSETS", "run_worker_first": ["/connect", "/connect/*"] },
  "triggers": { "crons": ["*/15 * * * *"] },
  "vars": { "AUTH_PROVIDER": "" },
  "env": { "prod": { "name": "vault-prod", "d1_databases": [{ "binding": "DB", "database_name": "p", "database_id": "11111111-2222-3333-4444-555555555555" }] } }
}`

export function sources(): Omit<StageInput, 'outDir'> & { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ops210-src-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(join(root, 'migrations'), { recursive: true })
  writeFileSync(join(root, 'vibase.js'), '#!/usr/bin/env node\nconsole.log(1)\n')
  writeFileSync(join(root, 'instance.js'), 'export const runInstance = () => 0\n')
  writeFileSync(join(root, 'worker.js'), 'export default {}\n')
  writeFileSync(join(root, 'assets', 'index.html'), '<html></html>')
  writeFileSync(join(root, 'assets', 'connect.js'), 'x')
  const mig = [
    ['0001_a.sql', 'create table a(id integer);\n'],
    ['0002_b.sql', 'create table b(id integer);\n'],
  ] as const
  for (const [n, t] of mig) writeFileSync(join(root, 'migrations', n), t)
  return {
    root,
    version: '0.1.0',
    commit: 'abc1234',
    builtAt: '2026-11-13T00:00:00.000Z',
    wranglerVersion: '4.149.0',
    compatibilityDate: '2026-07-30',
    node: '>=22',
    cliJs: join(root, 'vibase.js'),
    instanceJs: join(root, 'instance.js'),
    workerEntry: join(root, 'worker.js'),
    assetsConnectDir: join(root, 'assets'),
    migrationsDir: join(root, 'migrations'),
    baseConfigText: BASE_SOURCE,
    license: 'LICENSE text\n',
    readme: '# vibase\n',
    migrations: mig.map(([name, t]) => ({ name, sha256: sha256(t) })),
  }
}
export type { ManifestInput }
