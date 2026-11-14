// Test helper: a small valid source set for `stageRelease`, in a fresh temp directory.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, type ManifestInput } from './manifest.js'
import type { StageInput } from './stage.js'

export const BASE_SOURCE = `{
  // comment
  "name": "vb",
  "main": "src/worker.ts",
  "compatibility_date": "2026-07-30",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    { "binding": "DB", "database_name": "vb-crm", "database_id": "00000000-0000-0000-0000-000000000000", "migrations_dir": "../storage-d1/migrations" },
    { "binding": "CONTROL_DB", "database_name": "vb-control", "database_id": "00000000-0000-0000-0000-000000000001", "migrations_dir": "../storage-d1/control-migrations" }
  ],
  "assets": { "directory": "./dist/assets", "binding": "ASSETS", "run_worker_first": ["/connect", "/connect/*", "/sign-in", "/invite", "/reset-password", "/consent", "/device", "/ui/*"] },
  "triggers": { "crons": ["*/15 * * * *"] },
  "vars": { "AUTH_PROVIDER": "" },
  "env": { "prod": { "name": "vb-prod", "d1_databases": [{ "binding": "DB", "database_name": "p", "database_id": "11111111-2222-3333-4444-555555555555" }] } }
}`

export function sources(): Omit<StageInput, 'outDir'> & { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ops210-src-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(join(root, 'migrations'), { recursive: true })
  mkdirSync(join(root, 'control-migrations'), { recursive: true })
  writeFileSync(join(root, 'vibase.js'), '#!/usr/bin/env node\nconsole.log(1)\n')
  writeFileSync(join(root, 'server.js'), '#!/usr/bin/env node\nconsole.log(2)\n')
  writeFileSync(join(root, 'worker.js'), 'export default {}\n')
  writeFileSync(join(root, 'assets', 'index.html'), '<html></html>')
  writeFileSync(join(root, 'assets', 'connect.js'), 'x')
  // [[UI246]] D2: the auth pages' build output (`ui/` of the assets directory): index, bundle and stylesheet.
  mkdirSync(join(root, 'ui-assets'), { recursive: true })
  writeFileSync(join(root, 'ui-assets', 'index.html'), '<html></html>')
  writeFileSync(join(root, 'ui-assets', 'app.js'), 'y')
  writeFileSync(join(root, 'ui-assets', 'ui.css'), 'z')
  const mig = [
    ['0001_a.sql', 'create table a(id integer);\n'],
    ['0002_b.sql', 'create table b(id integer);\n'],
  ] as const
  for (const [n, t] of mig) writeFileSync(join(root, 'migrations', n), t)
  const ctl = [
    ['0001_c.sql', 'create table c1(id integer);\n'],
    ['0002_d.sql', 'create table c2(id integer);\n'],
  ] as const
  for (const [n, t] of ctl) writeFileSync(join(root, 'control-migrations', n), t)
  return {
    root,
    version: '0.1.0',
    commit: 'abc1234',
    builtAt: '2026-11-13T00:00:00.000Z',
    wranglerVersion: '4.149.0',
    compatibilityDate: '2026-07-30',
    node: '>=22',
    cliJs: join(root, 'vibase.js'),
    serverJs: join(root, 'server.js'),
    workerEntry: join(root, 'worker.js'),
    assetsConnectDir: join(root, 'assets'),
    assetsUiDir: join(root, 'ui-assets'),
    migrationsDir: join(root, 'migrations'),
    controlMigrationsDir: join(root, 'control-migrations'),
    baseConfigText: BASE_SOURCE,
    license: 'LICENSE text\n',
    clientReadme: '# @vibase/cli\n',
    serverReadme: '# @vibase/server-d1\n',
    migrations: mig.map(([name, t]) => ({ name, sha256: sha256(t) })),
    controlMigrations: ctl.map(([name, t]) => ({ name, sha256: sha256(t) })),
  }
}
export type { ManifestInput }
