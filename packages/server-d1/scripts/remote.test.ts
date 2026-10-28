import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PLACEHOLDER_DATABASE_ID, RemoteRefusal, deployCommands, loadRootEnv, migrateCommands, parseEnvFlag, requireConfirm, resolveTarget } from './remote.js'

const UUID = '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b'
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const snapshot = { ...process.env }
const dirs: string[] = []
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k]
  Object.assign(process.env, snapshot)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const good = { name: 'vault-smoked1', d1_databases: [{ binding: 'DB', database_name: 'vault-smoked1', database_id: UUID, remote: true }] }
const refusal = (fn: () => unknown, message: string) => {
  expect(fn).toThrow(RemoteRefusal)
  expect(fn).toThrow(message)
}

describe('parseEnvFlag (C3)', () => {
  it('requires --env', () => {
    refusal(() => parseEnvFlag([]), '--env <name> is required')
    refusal(() => parseEnvFlag(['--env', '']), '--env <name> is required')
  })
  it('reads both forms', () => {
    expect(parseEnvFlag(['--', '--env', 'smoked1'])).toBe('smoked1')
    expect(parseEnvFlag(['--env=smoked1'])).toBe('smoked1')
  })
})

describe('requireConfirm (C3)', () => {
  it.each([{}, { CONFIRM_REMOTE: 'true' }, { CONFIRM_REMOTE: '0' }])('refuses %j', (env) => {
    refusal(() => requireConfirm(env), 'set CONFIRM_REMOTE=1 to run against a remote instance')
  })
  it('accepts exactly 1', () => {
    expect(() => requireConfirm({ CONFIRM_REMOTE: '1' })).not.toThrow()
  })
})

describe('resolveTarget (C4)', () => {
  it('refuses the top level (an unknown env)', () => {
    refusal(() => resolveTarget({ name: 'vault', d1_databases: [{ binding: 'DB', database_id: PLACEHOLDER_DATABASE_ID }] }, 'nope'), 'unknown env nope')
  })
  it('refuses an env with no DB binding', () => {
    refusal(() => resolveTarget({ name: 'vault-x', d1_databases: [] }, 'x'), 'env x has no DB binding')
  })
  it('refuses the placeholder id', () => {
    const c = { name: 'vault-smoked1', d1_databases: [{ binding: 'DB', database_id: PLACEHOLDER_DATABASE_ID, remote: true }] }
    refusal(() => resolveTarget(c, 'smoked1'), 'env smoked1 still has the placeholder database_id: create the database and commit its id first')
  })
  it('refuses a binding that is not remote', () => {
    const c = { name: 'vault-smoked1', d1_databases: [{ binding: 'DB', database_id: UUID }] }
    refusal(() => resolveTarget(c, 'smoked1'), "env smoked1's DB binding must be remote: true with no preview_database_id")
  })
  it('refuses a differing preview_database_id', () => {
    const c = { name: 'vault-smoked1', d1_databases: [{ binding: 'DB', database_id: UUID, remote: true, preview_database_id: OTHER }] }
    refusal(() => resolveTarget(c, 'smoked1'), "env smoked1's DB binding must be remote: true with no preview_database_id")
  })
  it('resolves a good target', () => {
    expect(resolveTarget(good, 'smoked1')).toEqual({ env: 'smoked1', workerName: 'vault-smoked1', databaseName: 'vault-smoked1', databaseId: UUID })
  })
})

describe('commands (C5, C6)', () => {
  it('migrate: list, then apply, remote, for the env', () => {
    expect(migrateCommands('smoked1')).toEqual([
      { command: 'pnpm', args: ['exec', 'wrangler', 'd1', 'migrations', 'list', 'DB', '--remote', '--env', 'smoked1'] },
      { command: 'pnpm', args: ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--env', 'smoked1'] },
    ])
  })
  it('deploy: typecheck, test, then deploy with the version', () => {
    expect(deployCommands('smoked1', 'abc123')).toEqual([
      { command: 'pnpm', args: ['-C', 'packages/server-d1', 'typecheck'] },
      { command: 'pnpm', args: ['-C', 'packages/server-d1', 'test'] },
      { command: 'pnpm', args: ['exec', 'wrangler', 'deploy', '--env', 'smoked1', '--var', 'VERSION:abc123'] },
    ])
  })
})

describe('loadRootEnv (C3)', () => {
  it('refuses without credentials and leaks no value', () => {
    delete process.env.CLOUDFLARE_API_TOKEN
    delete process.env.CLOUDFLARE_ACCOUNT_ID
    const dir = mkdtempSync(join(tmpdir(), 'ops4-env-'))
    dirs.push(dir)
    const file = join(dir, '.env')
    writeFileSync(file, 'CLOUDFLARE_ACCOUNT_ID=acct-SECRETVALUE\nOTHER=x\n')
    let message = ''
    try {
      loadRootEnv(file)
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteRefusal)
      message = (err as Error).message
    }
    expect(message).toBe('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env')
    expect(message).not.toContain('SECRETVALUE')
  })
})
