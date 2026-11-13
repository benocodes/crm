import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONTROL_MIGRATIONS, MIGRATIONS } from '@vibase/storage-d1'
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
    const d = { ...deps('[]'), readConfig: () => ({ ...config, name: 'vb' }) }
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
    // a real remote: the SQLite message is in `notes`, the `text` is the API wrapper (first hq run)
    const real = '{"error":{"text":"A request to the Cloudflare API (/accounts/a/d1/database/b/query) failed.","notes":[{"text":"no such table: d1_migrations: SQLITE_ERROR [code: 7500]"}],"code":7500}}'
    expect(parseTrackerOutput(real)).toBeNull()
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
    expect(r.out).toContain(`migrations: current (${EXPECTED.length} applied, ${EXPECTED.length} expected)`)
  })
  it('behind exits 1 and names what is missing', () => {
    const r = run(rows(EXPECTED.slice(0, -1)))
    expect(r.code).toBe(1)
    expect(r.out).toContain(`migrations: behind (${EXPECTED.length - 1} applied, ${EXPECTED.length} expected)`)
    expect(r.out).toContain(`missing  ${EXPECTED[EXPECTED.length - 1]}`)
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

// [[OPS260]] D4, D14: the control database beside the CRM one. Control tracker state x CRM state; exit 0 only for (no entry | current) x current; every refusal names its database.
describe('db:status:remote per database (OPS260 matrix)', () => {
  const CONTROL_UUID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
  const rows = (names: string[]) => JSON.stringify([{ results: names.map((name) => ({ name })), success: true }])
  const CONTROL = CONTROL_MIGRATIONS.map((m) => m.name)
  const controlOutput = {
    none: null,
    unknown: fixture('d1-execute-missing-table.json'),
    behind: rows([]),
    current: rows(CONTROL),
    ahead: rows([...CONTROL, '0099_from_the_future.sql']),
  } as const
  const crmOutput = { current: rows(EXPECTED), behind: rows(EXPECTED.slice(0, -1)) } as const
  const run = (control: keyof typeof controlOutput, crm: keyof typeof crmOutput) => {
    const calls: string[] = []
    const out: string[] = []
    const withControl = { ...config, d1_databases: [...config.d1_databases, { binding: 'CONTROL_DB', database_name: 'vb-control-smoked1', database_id: CONTROL_UUID, remote: true }] }
    const d: StatusDeps = {
      loadEnv: () => {},
      readConfig: () => (control === 'none' ? config : withControl),
      exec: (cmd) => {
        calls.push(cmd.args.join(' '))
        return { status: 0, stdout: cmd.args.includes('CONTROL_DB') ? controlOutput[control]! : crmOutput[crm] }
      },
      log: (l) => void out.push(l),
    }
    const code = runStatus(['--env', 'smoked1'], { CONFIRM_REMOTE: '1' }, d)
    return { code, out: out.join('\n'), calls }
  }
  const cases = (['none', 'unknown', 'behind', 'current', 'ahead'] as const).flatMap((c) => (['current', 'behind'] as const).map((m) => [c, m] as const))
  it.each(cases)('control %s x crm %s', (control, crm) => {
    const r = run(control, crm)
    const ok = (control === 'none' || control === 'current') && crm === 'current'
    expect(r.code).toBe(ok ? 0 : 1)
    if (crm === 'behind') expect(r.out).toMatch(/\[crm\] migrations: behind/)
    if (crm === 'current') expect(r.out).toMatch(/\[crm\] migrations: current/)
    if (control === 'none') {
      expect(r.out).toContain('control plane: not configured for env smoked1')
      expect(r.calls.some((c) => c.includes('CONTROL_DB'))).toBe(false)
    } else {
      expect(r.out).toContain(`[control] migrations: ${control}`)
      expect(r.calls.some((c) => c.includes('CONTROL_DB') && c.includes('--remote') && c.includes('--env smoked1'))).toBe(true)
    }
  })
  it('the control database with no d1_migrations table is unknown, not current (the empty state)', () => {
    const r = run('unknown', 'current')
    expect(r.code).toBe(1)
    expect(r.out).toContain('[control] migrations: unknown (no d1_migrations table;')
  })
  it('control ahead names the extra file and is not current', () => {
    const r = run('ahead', 'current')
    expect(r.code).toBe(1)
    expect(r.out).toContain('extra    0099_from_the_future.sql')
  })
})
