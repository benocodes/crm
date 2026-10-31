import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from '@vault/storage-d1'
import { RemoteRefusal, formatMigrationDiff, parseTrackerOutput, statusExitCode, statusOf, trackerReadCommand } from './remote.js'
import { EXPECTED, runStatus, type StatusDeps } from './status-remote.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8')
const UUID = '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b'
const config = { name: 'vault-smoked1', d1_databases: [{ binding: 'DB', database_name: 'vault-smoked1', database_id: UUID, remote: true }] }

function deps(stdout: string, calls: string[] = []): StatusDeps & { out: string[] } {
  const out: string[] = []
  return {
    out,
    loadEnv: () => void calls.push('loadEnv'),
    readConfig: () => config,
    exec: (cmd) => {
      calls.push(cmd.args.join(' '))
      return { status: 0, stdout }
    },
    log: (l) => void out.push(l),
  }
}

describe('db:status:remote guards (same as db:migrate:remote)', () => {
  it('refuses without CONFIRM_REMOTE, before any command', () => {
    const calls: string[] = []
    expect(() => runStatus(['--env', 'smoked1'], {}, deps(fixture('d1-execute-migrations.json'), calls))).toThrow('set CONFIRM_REMOTE=1')
    expect(calls).toEqual([])
  })
  it('refuses without --env', () => {
    const calls: string[] = []
    expect(() => runStatus([], { CONFIRM_REMOTE: '1' }, deps('[]', calls))).toThrow(RemoteRefusal)
    expect(calls).toEqual([])
  })
  it('refuses the local top-level config', () => {
    const d = { ...deps('[]'), readConfig: () => ({ ...config, name: 'vault' }) }
    expect(() => runStatus(['--env', 'nope'], { CONFIRM_REMOTE: '1' }, d)).toThrow('unknown env nope')
  })
  it('reads through wrangler d1 execute --remote --json for the named env', () => {
    const c = trackerReadCommand('smoked1')
    expect(c.args).toEqual(expect.arrayContaining(['d1', 'execute', 'DB', '--remote', '--json', '--env', 'smoked1']))
  })
})

describe('parseTrackerOutput (recorded wrangler d1 execute --json output)', () => {
  it('reads the applied names', () => {
    expect(parseTrackerOutput(fixture('d1-execute-migrations.json'))).toEqual(MIGRATIONS.map((m) => m.name))
  })
  it('a missing table is null', () => {
    expect(parseTrackerOutput(fixture('d1-execute-missing-table.json'))).toBeNull()
  })
  it('any other error or shape throws', () => {
    expect(() => parseTrackerOutput('{"error":{"text":"auth failed"}}')).toThrow('auth failed')
    expect(() => parseTrackerOutput('not json')).toThrow()
    expect(() => parseTrackerOutput('[{"nope":1}]')).toThrow()
  })
})

describe('the diff and the exit code (D7, D9)', () => {
  const run = (stdout: string) => {
    const d = deps(stdout)
    const code = runStatus(['--env', 'smoked1'], { CONFIRM_REMOTE: '1' }, d)
    return { code, out: d.out.join('\n') }
  }
  const rows = (names: string[]) => JSON.stringify([{ results: names.map((name) => ({ name })), success: true }])

  it('current exits 0', () => {
    const r = run(fixture('d1-execute-migrations.json'))
    expect(r.code).toBe(0)
    expect(r.out).toContain('migrations: current (4 applied, 4 expected)')
  })
  it('behind exits 1 and names what is missing', () => {
    const r = run(rows(EXPECTED.slice(0, 3)))
    expect(r.code).toBe(1)
    expect(r.out).toContain('migrations: behind (3 applied, 4 expected)')
    expect(r.out).toContain(`missing  ${EXPECTED[3]}`)
  })
  it('ahead exits 1', () => {
    const r = run(rows([...EXPECTED, '9999_future.sql']))
    expect(r.code).toBe(1)
    expect(r.out).toContain('extra    9999_future.sql')
  })
  it('unknown (no tracker) exits 1', () => {
    const r = run(fixture('d1-execute-missing-table.json'))
    expect(r.code).toBe(1)
    expect(r.out).toContain('migrations: unknown')
  })
  it('statusExitCode and formatMigrationDiff agree with statusOf', () => {
    expect(statusExitCode(statusOf(EXPECTED, EXPECTED))).toBe(0)
    expect(formatMigrationDiff(null, EXPECTED)).toHaveLength(1)
  })
})
