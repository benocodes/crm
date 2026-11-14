import { describe, expect, it } from 'vitest'
import { PLACEHOLDER_DATABASE_ID, RemoteRefusal } from './remote.js'
import { migrateCommands } from './remote.js'
import { runMigrate, type MigrateDeps } from './migrate-remote.js'

// [[OPS260]] D14: the wrangler exec is faked; nothing here reaches a remote database.
const UUID = '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b'
const CONTROL_UUID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const crmOnly = { name: 'vault-smoked1', d1_databases: [{ binding: 'DB', database_name: 'vault-smoked1', database_id: UUID, remote: true }] }
const both = { ...crmOnly, d1_databases: [...crmOnly.d1_databases, { binding: 'CONTROL_DB', database_name: 'vb-control-smoked1', database_id: CONTROL_UUID, remote: true }] }
const MISSING = JSON.stringify({ error: { text: 'x', notes: [{ text: 'no such table: d1_migrations' }] } })

function fake(config: object, failOn?: (args: string) => boolean) {
  const calls: string[] = []
  const out: string[] = []
  const deps: MigrateDeps = {
    loadEnv: () => void calls.push('loadEnv'),
    readConfig: () => config as never,
    exec: (cmd) => {
      const a = cmd.args.join(' ')
      calls.push(a)
      return { status: failOn?.(a) ? 1 : 0, stdout: cmd.args.includes('execute') ? MISSING : '' }
    },
    log: (l) => void out.push(l),
  }
  return { deps, calls, out }
}
const applies = (calls: string[]) => calls.filter((c) => c.includes('migrations apply'))
const run = (config: object, failOn?: (a: string) => boolean) => {
  const f = fake(config, failOn)
  const code = runMigrate(['--env', 'smoked1'], { CONFIRM_REMOTE: '1' }, f.deps)
  return { code, ...f }
}

describe('migrateCommands per database', () => {
  it('an env with a control database: control list and apply first, each against CONTROL_DB, then DB; all --remote --env', () => {
    expect(migrateCommands('smoked1', { control: true }).map((c) => c.args.slice(3).join(' '))).toEqual([
      'migrations list CONTROL_DB --remote --env smoked1',
      'migrations apply CONTROL_DB --remote --env smoked1',
      'migrations list DB --remote --env smoked1',
      'migrations apply DB --remote --env smoked1',
    ])
  })
})

describe('db:migrate:remote (OPS260 D14)', () => {
  it('applies the control directory before the CRM one, each against its own binding and --env', () => {
    const r = run(both)
    expect(r.code).toBe(0)
    const a = applies(r.calls)
    expect(a).toHaveLength(2)
    expect(a[0]).toContain('CONTROL_DB')
    expect(a[0]).toContain('--env smoked1')
    expect(a[1]).toMatch(/apply DB --remote --env smoked1/)
    expect(r.calls.indexOf(a[0]!)).toBeLessThan(r.calls.indexOf(a[1]!))
  })
  it('a failing control apply stops before the CRM apply, with a non-zero exit', () => {
    const r = run(both, (a) => a.includes('migrations apply CONTROL_DB'))
    expect(r.code).not.toBe(0)
    expect(applies(r.calls)).toEqual([expect.stringContaining('CONTROL_DB')])
    expect(r.calls.some((c) => c.includes('migrations apply DB'))).toBe(false)
  })
  it('an env without a CONTROL_DB entry applies the CRM only and prints the not-configured line', () => {
    const r = run(crmOnly)
    expect(r.code).toBe(0)
    expect(applies(r.calls)).toEqual([expect.stringMatching(/apply DB --remote --env smoked1/)])
    expect(r.calls.some((c) => c.includes('CONTROL_DB'))).toBe(false)
    expect(r.out).toContain('control plane: not configured for env smoked1 (CRM only)')
  })
  it('a placeholder id is refused before any exec', () => {
    for (const cfg of [{ ...crmOnly, d1_databases: [{ ...crmOnly.d1_databases[0]!, database_id: PLACEHOLDER_DATABASE_ID }] }, { ...both, d1_databases: [both.d1_databases[0]!, { ...both.d1_databases[1]!, database_id: '00000000-0000-0000-0000-000000000001' }] }]) {
      const f = fake(cfg)
      expect(() => runMigrate(['--env', 'smoked1'], { CONFIRM_REMOTE: '1' }, f.deps)).toThrow(RemoteRefusal)
      expect(f.calls.filter((c) => c !== 'loadEnv')).toEqual([])
    }
  })
  it('refuses without CONFIRM_REMOTE before anything runs', () => {
    const f = fake(both)
    expect(() => runMigrate(['--env', 'smoked1'], {}, f.deps)).toThrow('set CONFIRM_REMOTE=1')
    expect(f.calls).toEqual([])
  })
})
