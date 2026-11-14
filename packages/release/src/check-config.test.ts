// [[OPS260]] D14 + D16: the config `release:check` generates from the installed package's base config: each d1_databases entry gets its own migrations directory by binding, with distinct ids and the vb- names.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import { ReleaseRefusal } from './errors.js'
import { deriveBaseConfig } from './stage.js'
import { checkConfig } from './check-config.js'

const SOURCE = readFileSync(new URL('../../server-d1/wrangler.jsonc', import.meta.url), 'utf8')
const base = (): Record<string, any> => deriveBaseConfig(SOURCE, { main: 'worker/worker.js', assetsDirectory: 'assets', migrationsDir: 'migrations', controlMigrationsDir: 'control-migrations' })
const INSTALLED = '/x/node_modules/@vibase/server-d1'

describe('checkConfig', () => {
  it('has two entries, each with its own directory by binding, distinct ids and the vb-crm / vb-control names', () => {
    const c = checkConfig(base(), INSTALLED) as Record<string, any>
    expect(c.d1_databases).toHaveLength(2)
    const byBinding = Object.fromEntries(c.d1_databases.map((d: any) => [d.binding, d]))
    expect(Object.keys(byBinding).sort()).toEqual(['CONTROL_DB', 'DB'])
    expect(byBinding.DB.migrations_dir).toBe(`${INSTALLED}/migrations`)
    expect(byBinding.CONTROL_DB.migrations_dir).toBe(`${INSTALLED}/control-migrations`)
    expect(byBinding.DB.database_id).not.toBe(byBinding.CONTROL_DB.database_id)
    expect(byBinding.DB.database_name).toBe('vb-crm')
    expect(byBinding.CONTROL_DB.database_name).toBe('vb-control')
    expect(c.main).toBe(`${INSTALLED}/worker/worker.js`)
    expect(c.assets.directory).toBe(`${INSTALLED}/assets`)
  })
  it('works from the real source config of the repo (the base the package ships)', () => {
    expect(parse(SOURCE).d1_databases.map((d: any) => d.binding)).toEqual(['DB', 'CONTROL_DB'])
  })
  it('refuses a base config with no CONTROL_DB entry', () => {
    const b = base()
    b.d1_databases = b.d1_databases.filter((d: any) => d.binding !== 'CONTROL_DB')
    expect(() => checkConfig(b, INSTALLED)).toThrow(/CONTROL_DB/)
  })
  it('refuses two entries that share a database_id (local wrangler keys the file by it: one database)', () => {
    const b = base()
    b.d1_databases[1].database_id = b.d1_databases[0].database_id
    expect(() => checkConfig(b, INSTALLED)).toThrow(ReleaseRefusal)
    expect(() => checkConfig(b, INSTALLED)).toThrow(/distinct/)
  })
  it('refuses an entry of an unknown binding (no directory to apply to it)', () => {
    const b = base()
    b.d1_databases.push({ binding: 'OTHER', database_name: 'x', database_id: 'id-3' })
    expect(() => checkConfig(b, INSTALLED)).toThrow(/OTHER/)
  })
  it('refuses names other than vb-crm and vb-control', () => {
    const b = base()
    b.d1_databases[1].database_name = 'vault-control'
    expect(() => checkConfig(b, INSTALLED)).toThrow(/vb-control/)
  })
})
