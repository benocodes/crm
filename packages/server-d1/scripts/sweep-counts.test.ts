import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SWEEP_CONTROL_READ, SWEEP_CRM_READ, classifySweep, parseSweepControlRows, parseSweepCrmRows } from '@vibase/storage-d1'
import { readSweepCounts, sweepCountLines } from './sweep-counts.js'
import { controlStdout, countsFacts, crmStdout, isReadOnlySql, wranglerJson } from './sweep-counts-kit.js'

// [[CORE289]] P6: the counts' wrangler output pinned to fixtures captured ONCE from a real `wrangler d1 execute --local --json` run (a local control database migrated from control-migrations/,
// a local CRM database migrated from migrations/, a few rows inserted); the kit that both front-ends' tests use builds the same shape.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8')
const rowsOf = (stdout: string) => (JSON.parse(stdout) as Array<{ results: Array<Record<string, unknown>> }>)[0]!.results

describe('the real wrangler output', () => {
  it('the captured control and CRM fixtures parse into the facts that were inserted', () => {
    const control = parseSweepControlRows(rowsOf(fixture('d1-execute-sweep-control.json')))
    expect(control.users.map((u) => u.id).sort()).toEqual(['u1', 'u2'])
    expect(control.credentialSubjects).toEqual(['u1'])
    expect(control.invitations).toEqual([expect.objectContaining({ email: 'b@x.test', acceptedAt: null, revokedAt: null })])
    expect(parseSweepCrmRows(rowsOf(fixture('d1-execute-sweep-crm.json'))).linked).toEqual([{ subject: 'u1', authority: true }, { subject: 'u3', authority: false }])
  })
  it('the kit builds the same shape as the capture (same keys, same value types), so a front-end test over the kit stands for the real output', () => {
    const real = rowsOf(fixture('d1-execute-sweep-control.json'))
    const built = rowsOf(controlStdout(parseSweepControlRows(real)))
    expect(built.map((r) => Object.keys(r))).toEqual(real.map((r) => Object.keys(r)))
    expect(parseSweepControlRows(built)).toEqual(parseSweepControlRows(real))
    expect(JSON.parse(crmStdout(parseSweepCrmRows(rowsOf(fixture('d1-execute-sweep-crm.json')))))).toEqual(JSON.parse(wranglerJson(rowsOf(fixture('d1-execute-sweep-crm.json')))))
  })
  it('both statements are read-only', () => {
    expect(isReadOnlySql(SWEEP_CONTROL_READ)).toBe(true)
    expect(isReadOnlySql(SWEEP_CRM_READ)).toBe(true)
    expect(isReadOnlySql('delete from auth_users')).toBe(false)
  })
})

describe('classifySweep', () => {
  const f = countsFacts(Date.parse('2026-11-15T12:00:00.000Z'))
  const now = '2026-11-15T12:00:00.000Z'
  it('the fixture: one subject to revoke, one orphan to delete', () => {
    expect(classifySweep({ now, ...f })).toEqual({ revoke: ['gone'], orphans: ['orphan'] })
  })
  it('a linked subject with no credentials left is not pending revocation (a second tick writes nothing)', () => {
    expect(classifySweep({ now, control: { ...f.control, credentialSubjects: ['live'] }, crm: f.crm }).revoke).toEqual([])
  })
  it('an unlinked subject with credentials is never revoked, only deleted with its account', () => {
    expect(classifySweep({ now, control: { ...f.control, credentialSubjects: ['young', 'orphan'] }, crm: f.crm }).revoke).toEqual([])
  })
})

describe('readSweepCounts and the printed lines', () => {
  const f = countsFacts()
  const run = (binding: 'DB' | 'CONTROL_DB', sql: string) => {
    if (binding === 'CONTROL_DB' && sql === SWEEP_CONTROL_READ) return controlStdout(f.control)
    if (binding === 'DB' && sql === SWEEP_CRM_READ) return crmStdout(f.crm)
    throw new Error('unexpected read')
  }
  it('counts what the classifier says', () => {
    expect(readSweepCounts(run, new Date())).toEqual(f.expected)
  })
  it('unavailable when a read throws or its output is unreadable', () => {
    expect(readSweepCounts(() => { throw new Error('wrangler failed') }, new Date())).toBeNull()
    expect(readSweepCounts(() => 'not json', new Date())).toBeNull()
    expect(readSweepCounts(() => '{"error":{"text":"no such table: invitations"}}', new Date())).toBeNull()
  })
  it('lines', () => {
    expect(sweepCountLines({ revoke: 2, orphans: 1 })).toEqual(['sweep: 2 subject(s) pending revocation', 'sweep: 1 orphan account(s) pending deletion'])
    expect(sweepCountLines(null)).toEqual(['sweep: counts unavailable'])
  })
})
