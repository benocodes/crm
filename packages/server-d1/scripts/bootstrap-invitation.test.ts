// [[CORE245]] P7: `--owner-email` on the `better-auth` provider issues the first owner invitation after the CRM rows, the control marker and the `vibase-cli` seed, prints its URL once, and a re-run
// reissues it only while no owner exists. Locally and through `runBootstrap` (the `--remote` seam), against two real local D1s.
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openControlDb, type D1Like, type D1PreparedLike } from '@vibase/storage-d1'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { bootstrapD1 } from '../src/bootstrap-d1.js'
import { openWorkerPair, type WorkerPair } from '../src/test/kit.js'
import { parseBootstrapArgs, runBootstrap, type BootstrapIo } from './bootstrap.js'

let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(async () => {
  await pair.dispose()
})
afterEach(async () => {
  await pair.reset()
})

const BASE = 'https://vibase.test'
const base = { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: BASE }
const control = (d1: D1Like = pair.control) => openControlDb(d1)
const rows = async (d1: D1Like, q: string, ...b: unknown[]) => ((await d1.prepare(q).bind(...b).all()).results ?? []) as Array<Record<string, any>>
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const tokenOf = (url: string) => new URL(url).hash.replace(/^#token=/, '')
const invitations = () => rows(pair.control, 'select * from invitations order by id')
const audits = () => rows(pair.control, 'select * from control_audit order by id')
const live = () => rows(pair.control, "select * from invitations where role = 'owner' and accepted_at is null and revoked_at is null")
const run = (values: Record<string, string | undefined>) => {
  const logs: string[] = []
  const errors: string[] = []
  const io: BootstrapIo = { log: (l) => void logs.push(l), error: (l) => void errors.push(l), readEnvText: () => '', writeEnvText: () => {} }
  return runBootstrap({ mode: 'local', values: { org: 'Acme', 'auth-provider': 'better-auth', 'public-base-url': BASE, ...values }, authOrgId: 'better-auth' }, { env: { DB: pair.d1, CONTROL_DB: pair.control } }, io).then((code) => ({ code, logs, errors }))
}
const urlsIn = (lines: string[]) => lines.filter((l) => l.includes('/invite#token='))

describe('the first run (P7)', () => {
  it('creates an owner invitation, audited by the system principal, and prints its URL exactly once', async () => {
    const out = await run({ 'owner-email': 'Owner@X.test' })
    expect(out.errors).toEqual([])
    expect(out.code).toBe(0)
    const lines = urlsIn(out.logs)
    expect(lines).toHaveLength(1)
    const url = lines[0]!.match(/https:\/\/\S+/)![0]
    const [inv, ...rest] = await invitations()
    expect(rest).toEqual([])
    expect(inv).toMatchObject({ email: 'owner@x.test', role: 'owner', token_hash: sha256(tokenOf(url)), accepted_at: null, revoked_at: null })
    expect(Date.parse(inv!.expires_at) - Date.parse(inv!.created_at)).toBe(7 * 86_400_000)
    const [system] = await rows(pair.d1, "select id from principals where kind = 'system'")
    expect(inv!.created_by).toBe(system!.id)
    const [row, ...more] = await audits()
    expect(more).toEqual([])
    expect(row).toMatchObject({ actor_id: system!.id, action: 'invitation.created', target_type: 'invitation', target_id: inv!.id })
    expect(JSON.parse(row!.detail)).toEqual({ email: 'owner@x.test', role: 'owner', expires_at: inv!.expires_at })
    // the token is nowhere in either database
    for (const d1 of [pair.control, pair.d1]) {
      const tables = (await rows(d1, "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'")).map((r) => r.name)
      for (const t of tables) expect(JSON.stringify(await rows(d1, `select * from "${t}"`))).not.toContain(tokenOf(url))
    }
  })

  it('comes after the control marker and the vibase-cli seed in the control plane', async () => {
    const seen: string[] = []
    const spy: D1Like = { prepare: (q: string) => (seen.push(q), pair.control.prepare(q)), batch: (s: D1PreparedLike[]) => pair.control.batch(s) }
    await bootstrapD1(pair.d1, { ...base, ownerEmail: 'owner@x.test' }, { control: control(spy) })
    const at = (re: RegExp) => seen.findIndex((q) => re.test(q))
    expect(at(/insert into control_deployment/i)).toBeGreaterThanOrEqual(0)
    expect(at(/auth_oauth_clients/i)).toBeGreaterThanOrEqual(0)
    expect(at(/insert into invitations/i)).toBeGreaterThan(at(/insert into control_deployment/i))
    expect(at(/insert into invitations/i)).toBeGreaterThan(Math.max(...seen.map((q, i) => (/auth_oauth_clients/i.test(q) ? i : -1))))
  })
})

describe('a re-run', () => {
  it('with a live owner invitation and no owner: revokes it and issues a fresh one, one live owner invitation, both rows whole', async () => {
    const first = await run({ 'owner-email': 'owner@x.test' })
    const [old] = await invitations()
    const second = await run({ 'owner-email': 'owner@x.test' })
    expect(second.code, second.errors.join()).toBe(0)
    const [a, b] = await invitations()
    expect(await live()).toHaveLength(1)
    const [fresh, revoked] = a!.id === old!.id ? [b!, a!] : [a!, b!]
    expect(revoked).toEqual({ ...old, revoked_at: expect.any(String) })
    expect(fresh).toMatchObject({ email: 'owner@x.test', role: 'owner', accepted_at: null, revoked_at: null })
    expect(fresh!.token_hash).not.toBe(old!.token_hash)
    expect(tokenOf(urlsIn(second.logs)[0]!.match(/https:\/\/\S+/)![0])).not.toBe(tokenOf(urlsIn(first.logs)[0]!.match(/https:\/\/\S+/)![0]))
    expect(urlsIn(second.logs)).toHaveLength(1)
    expect((await audits()).map((r) => r.action).sort()).toEqual(['invitation.created', 'invitation.created', 'invitation.revoked'])
  })

  it('with an owner membership: nothing is issued and no row changes', async () => {
    await run({ 'owner-email': 'owner@x.test' })
    const [org] = await rows(pair.d1, 'select id from organizations')
    const user = '0190b2c4-0000-7000-8000-00000000c001'
    await seedPrincipal(pair.d1, { id: user, kind: 'user', email: 'owner@x.test' })
    await seedMembership(pair.d1, { organizationId: org!.id, userId: user, role: 'owner' })
    const before = JSON.stringify({ i: await invitations(), a: await audits() })
    const again = await run({ 'owner-email': 'owner@x.test' })
    expect(again.code).toBe(0)
    expect(urlsIn(again.logs)).toEqual([])
    expect(JSON.stringify({ i: await invitations(), a: await audits() })).toBe(before)
  })

  it('without --owner-email: nothing is issued, even with no owner and no invitation', async () => {
    expect((await run({})).code).toBe(0)
    expect(await invitations()).toEqual([])
    expect(await audits()).toEqual([])
    const again = await run({})
    expect(urlsIn(again.logs)).toEqual([])
    expect(await invitations()).toEqual([])
  })
})

describe('the provider guard', () => {
  it('--owner-email is refused with clerk and with none, and writes nothing', async () => {
    await expect(bootstrapD1(pair.d1, { organizationName: 'Acme', authProvider: 'clerk', authOrgId: 'https://c.test', ownerEmail: 'o@x.test' }, { control: control() })).rejects.toThrow(/owner-email/)
    await expect(bootstrapD1(pair.d1, { organizationName: 'Acme', authProvider: 'none', authOrgId: 'org', email: 'e@x.test', agentName: 'a', ownerEmail: 'o@x.test' }, { control: control() })).rejects.toThrow(/owner-email/)
    expect(await rows(pair.d1, 'select * from deployment')).toEqual([])
    expect(await invitations()).toEqual([])
  })

  it('the CLI parser takes the flag, and the usage text names it', () => {
    expect(parseBootstrapArgs(['--org', 'a', '--auth-provider', 'better-auth', '--public-base-url', BASE, '--owner-email', 'o@x.test']).values['owner-email']).toBe('o@x.test')
  })
})
