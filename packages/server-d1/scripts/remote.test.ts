import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTROL_PLACEHOLDER_DATABASE_ID,
  PLACEHOLDER_DATABASE_ID,
  RemoteRefusal,
  deployCommands,
  loadRemoteEnv,
  remoteEnvFile,
  migrateCommands,
  parseEnvFlag,
  requireConfirm,
  requireControlTarget,
  resolveTarget,
} from './remote.js'

const UUID = '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b'
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const snapshot = { ...process.env }
const dirs: string[] = []
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k]
  Object.assign(process.env, snapshot)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const good = {
  name: 'vault-smoked1',
  d1_databases: [{ binding: 'DB', database_name: 'vault-smoked1', database_id: UUID, remote: true }],
}
const refusal = (fn: () => unknown, message: string) => {
  expect(fn).toThrow(RemoteRefusal)
  expect(fn).toThrow(message)
}

describe('the control placeholder ([[CORE259]])', () => {
  it('is its own id, and an env whose CONTROL_DB still holds either placeholder is refused', () => {
    expect(CONTROL_PLACEHOLDER_DATABASE_ID).not.toBe(PLACEHOLDER_DATABASE_ID)
    for (const id of [PLACEHOLDER_DATABASE_ID, CONTROL_PLACEHOLDER_DATABASE_ID]) {
      const config = {
        ...good,
        d1_databases: [
          ...good.d1_databases,
          { binding: 'CONTROL_DB', database_name: 'vb-control-smoked1', database_id: id, remote: true },
        ],
      }
      refusal(() => resolveTarget(config, 'smoked1'), 'CONTROL_DB still has a placeholder database_id')
    }
  })
})

describe('requireControlTarget ([[CORE326]] P4)', () => {
  const withControl = {
    ...good,
    d1_databases: [
      ...good.d1_databases,
      { binding: 'CONTROL_DB', database_name: 'vb-control-smoked1', database_id: OTHER, remote: true },
    ],
  }
  it('an env without a CONTROL_DB entry is refused, naming setup:remote --env <name>', () => {
    refusal(() => requireControlTarget(good, 'smoked1'), 'setup:remote --env smoked1')
  })
  it('an env with one resolves like resolveTarget, with the control target present', () => {
    expect(requireControlTarget(withControl, 'smoked1').control).toEqual({
      databaseName: 'vb-control-smoked1',
      databaseId: OTHER,
    })
  })
  it('the other guards still apply first (the local top level is unknown)', () => {
    refusal(() => requireControlTarget({ ...withControl, name: 'vb' }, 'nope'), 'unknown env nope')
  })
  it('no script prints a CRM-only line: the not-configured wording is in no non-test script source', () => {
    const dirs = ['.', 'instance', 'setup']
    const here = new URL('.', import.meta.url).pathname
    const offenders: string[] = []
    for (const d of dirs)
      for (const f of readdirSync(here + d)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'remote.test.ts') continue
        const text = readFileSync(`${here}${d}/${f}`, 'utf8')
        if (/control plane: not configured|\(CRM only\)|controlNotConfigured/.test(text)) offenders.push(`${d}/${f}`)
      }
    expect(offenders).toEqual([])
  })
})

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
    refusal(
      () =>
        resolveTarget({ name: 'vb', d1_databases: [{ binding: 'DB', database_id: PLACEHOLDER_DATABASE_ID }] }, 'nope'),
      'unknown env nope',
    )
  })
  it('refuses an env with no DB binding', () => {
    refusal(() => resolveTarget({ name: 'vibase-x', d1_databases: [] }, 'x'), 'env x has no DB binding')
  })
  it('refuses the placeholder id', () => {
    const c = {
      name: 'vault-smoked1',
      d1_databases: [{ binding: 'DB', database_id: PLACEHOLDER_DATABASE_ID, remote: true }],
    }
    refusal(
      () => resolveTarget(c, 'smoked1'),
      'env smoked1 still has the placeholder database_id: create the database and commit its id first',
    )
  })
  it('refuses a binding that is not remote', () => {
    const c = { name: 'vault-smoked1', d1_databases: [{ binding: 'DB', database_id: UUID }] }
    refusal(
      () => resolveTarget(c, 'smoked1'),
      "env smoked1's DB binding must be remote: true with no preview_database_id",
    )
  })
  it('refuses a differing preview_database_id', () => {
    const c = {
      name: 'vault-smoked1',
      d1_databases: [{ binding: 'DB', database_id: UUID, remote: true, preview_database_id: OTHER }],
    }
    refusal(
      () => resolveTarget(c, 'smoked1'),
      "env smoked1's DB binding must be remote: true with no preview_database_id",
    )
  })
  it('resolves a good target', () => {
    expect(resolveTarget(good, 'smoked1')).toEqual({
      env: 'smoked1',
      workerName: 'vault-smoked1',
      databaseName: 'vault-smoked1',
      databaseId: UUID,
    })
  })
})

describe('commands (C5, C6)', () => {
  it('migrate: list, then apply, remote, for the env', () => {
    expect(migrateCommands('smoked1')).toEqual([
      { command: 'pnpm', args: ['exec', 'wrangler', 'd1', 'migrations', 'list', 'DB', '--remote', '--env', 'smoked1'] },
      {
        command: 'pnpm',
        args: ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--env', 'smoked1'],
      },
    ])
  })
  it('deploy: build the page, typecheck, test, then deploy with the version and the commit', () => {
    expect(deployCommands('smoked1', 'abc123')).toEqual([
      { command: 'pnpm', args: ['-C', 'packages/server-d1', 'build'] },
      { command: 'pnpm', args: ['-C', 'packages/server-d1', 'typecheck'] },
      { command: 'pnpm', args: ['-C', 'packages/server-d1', 'test'] },
      {
        command: 'pnpm',
        args: ['exec', 'wrangler', 'deploy', '--env', 'smoked1', '--var', 'VERSION:abc123', '--var', 'COMMIT:abc123'],
      },
    ])
  })
})

describe('loadRemoteEnv (C3, #380)', () => {
  const CF = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']
  const repo = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ops4-env-'))
    dirs.push(dir)
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    return `${dir}/`
  }
  const clear = () => {
    for (const k of [...CF, 'VIBASE_SMOKED1_OPERATOR_KEY']) delete process.env[k]
  }

  it('refuses without credentials, names the file it looked in and leaks no value', () => {
    clear()
    const root = repo({ '.env.smoked1': 'CLOUDFLARE_ACCOUNT_ID=acct-SECRETVALUE\nOTHER=x\n' })
    let message = ''
    try {
      loadRemoteEnv('smoked1', root)
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteRefusal)
      message = (err as Error).message
    }
    expect(message).toBe('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env.smoked1')
    expect(message).not.toContain('SECRETVALUE')
  })

  it('smoked1 reads .env.smoked1 (credentials and the operator key) and never the root .env', () => {
    clear()
    const root = repo({
      '.env.smoked1':
        'CLOUDFLARE_ACCOUNT_ID=fake-acct\nCLOUDFLARE_API_TOKEN=fake-token\nVIBASE_SMOKED1_OPERATOR_KEY=fake-op\n',
      '.env': 'CLOUDFLARE_ACCOUNT_ID=root-acct\nCLOUDFLARE_API_TOKEN=root-token\nVIBASE_SMOKED1_OPERATOR_KEY=root-op\n',
    })
    loadRemoteEnv('smoked1', root)
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe('fake-acct')
    expect(process.env.CLOUDFLARE_API_TOKEN).toBe('fake-token')
    expect(process.env.VIBASE_SMOKED1_OPERATOR_KEY).toBe('fake-op')
  })

  it('smoked1 with only a root .env refuses: the root file is not a fallback', () => {
    clear()
    const root = repo({ '.env': 'CLOUDFLARE_ACCOUNT_ID=root-acct\nCLOUDFLARE_API_TOKEN=root-token\n' })
    refusal(() => loadRemoteEnv('smoked1', root), 'must be set in .env.smoked1')
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined()
  })

  it('existing process variables win over the file', () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'proc-acct'
    process.env.CLOUDFLARE_API_TOKEN = 'proc-token'
    const root = repo({ '.env.smoked1': 'CLOUDFLARE_ACCOUNT_ID=fake-acct\nCLOUDFLARE_API_TOKEN=fake-token\n' })
    loadRemoteEnv('smoked1', root)
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe('proc-acct')
  })

  it.each(['hq', 'hq-staging'])('%s: its env file is never sourced, and the root .env is not read either', (name) => {
    clear()
    const root = repo({
      [`.env.${name}`]: 'CLOUDFLARE_ACCOUNT_ID=hq-acct\nCLOUDFLARE_API_TOKEN=hq-token\n',
      '.env': 'CLOUDFLARE_ACCOUNT_ID=root-acct\nCLOUDFLARE_API_TOKEN=root-token\n',
    })
    refusal(() => loadRemoteEnv(name, root), `.env.${name} is never sourced`)
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined()
  })

  it('any other env keeps the root .env (a human operator path) and says so', () => {
    expect(remoteEnvFile('demo', '/r/').display).toBe('.env')
    clear()
    const root = repo({ '.env': 'CLOUDFLARE_ACCOUNT_ID=root-acct\nCLOUDFLARE_API_TOKEN=root-token\n' })
    loadRemoteEnv('demo', root)
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe('root-acct')
  })
})
