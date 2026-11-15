// [[OPS307]] groups 2, 3 and 4 as ONE shared body, run by each front-end's entry file (`instance/owner-reset.test.ts` for `vibase-server owner-reset`, `bootstrap-owner-reset.test.ts` for
// `bootstrap --remote --owner-reset`): the same targeting rule, the same link, the same invitation, whichever command asked. A front-end supplies a `Driver`; everything else is here.
// The real Better Auth handler (`authKit`) is composed over the same control D1 with the same AUTH_SECRET, so the printed link is judged by the library that would accept it on the Worker.
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createInvitation, hasLiveInvitationForToken, openControlDb, type D1Like, type D1PreparedLike } from '@vibase/storage-d1'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { uuidv7 } from '@vibase/storage'
import { bootstrapD1 } from '../src/bootstrap-d1.js'
import { openWorkerPair, spyD1, type WorkerPair } from '../src/test/kit.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from '../src/test/auth-kit.js'

/** What the instance's record and secrets file say, as a front-end must express them. Absent keys are the healthy `better-auth` instance. */
export interface RecordVariant {
  provider?: 'better-auth' | 'clerk' | 'none'
  /** `false`: the record binds no control database. */
  control?: boolean
  /** `null`: the record has no PUBLIC_BASE_URL. */
  baseUrl?: string | null
  /** `null`: the secrets file has no AUTH_SECRET. */
  secret?: string | null
}
export interface RunOptions {
  email?: string
  dryRun?: boolean
  record?: RecordVariant
  crm: D1Like
  control: D1Like
}
export interface Run {
  code: number
  out: string[]
  err: string[]
}
export interface Driver {
  /** The exit code of a refusal before any write, and of a failure after one (P6). */
  refused: number
  failed: number
  /** Only `vibase-server` has `--dry-run` (D9). */
  dryRun: boolean
  run(o: RunOptions): Promise<Run>
}

export const BASE = AUTH_BASE
export const SECRET = AUTH_SECRET
export const NEW_PASSWORD = 'a brand new password 456'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const rows = async (d1: D1Like, q: string, ...b: unknown[]) => ((await d1.prepare(q).bind(...b).all()).results ?? []) as Array<Record<string, any>>
const WRITE = /^\s*(insert|update|delete|replace|create|drop|alter)\b/i
/** Better Auth sweeps EXPIRED verification rows whenever it looks one up: its own housekeeping, not a change the command makes (it deletes nothing live). Everything else counts as a write. */
const LIBRARY_SWEEP = /^delete from "auth_verifications" where "auth_verifications"\."expires_at" < \?$/
const allText = (r: Run) => [...r.out, ...r.err].join('\n')

/** Every row of every table of a database, as one string: where "the token is nowhere" is looked for. `skip` names tables the library owns (its verification row holds the token it issued). */
async function dump(d1: D1Like, skip: string[] = []): Promise<string> {
  const tables = (await rows(d1, "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'")).map((r) => r.name as string).filter((t) => !skip.includes(t))
  return JSON.stringify(await Promise.all(tables.map(async (t) => [t, await rows(d1, `select * from "${t}"`)])))
}

/** A control D1 whose audit insert for a reset link fails (`recordResetLinkIssued` runs it with `.run()`). */
function failingAudit(real: D1Like): D1Like {
  return {
    prepare(q: string) {
      const p = real.prepare(q)
      if (!/user\.reset_link_issued/.test(q)) return p
      const boom = async () => {
        throw new Error('D1 audit write failed')
      }
      return { bind: () => ({ run: boom, all: boom, first: boom }), run: boom, all: boom, first: boom } as unknown as D1PreparedLike
    },
    batch: (s: D1PreparedLike[]) => real.batch(s),
  }
}

/** `dryRun`: whether the front-end has `--dry-run`; the dry-run case is only registered when it does, so a front-end without it never reports a test that did not run. */
export function ownerResetSuite(label: string, makeDriver: () => Driver | Promise<Driver>, opts: { dryRun: boolean }): void {
  describe(`owner-reset through ${label}`, () => {
    let pair: WorkerPair
    let kit: AuthKit
    let driver: Driver
    beforeAll(async () => {
      pair = await openWorkerPair()
      driver = await makeDriver()
    }, 60_000)
    afterAll(async () => {
      await pair.dispose()
    })
    afterEach(async () => {
      await pair.reset()
    })

    /** The initialised `better-auth` instance with the given owners. `account: false` leaves a membership with no Better Auth account behind it. */
    async function seed(owners: Array<{ email: string; provider?: string; account?: boolean }>) {
      kit = authKit(pair.control)
      const boot = await bootstrapD1(pair.d1, { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: BASE }, { control: openControlDb(pair.control) })
      const system = (await rows(pair.d1, "select id from principals where kind = 'system'"))[0]!.id as string
      const made: Array<{ email: string; userId: string; subject: string }> = []
      for (const o of owners) {
        const provider = o.provider ?? 'better-auth'
        const subject = provider === 'better-auth' && o.account !== false ? (await kit.signUp(o.email)).userId : `sub-${uuidv7()}`
        const userId = uuidv7()
        await seedPrincipal(pair.d1, { id: userId, kind: 'user', email: o.email, authProvider: provider, authSubject: subject })
        await seedMembership(pair.d1, { organizationId: boot.organizationId, userId, role: 'owner' })
        made.push({ email: o.email, userId, subject })
      }
      return { system, owners: made }
    }

    /** Runs the command over spies, and returns what it wrote. */
    async function drive(o: Partial<Pick<RunOptions, 'email' | 'dryRun' | 'record'>> & { control?: D1Like } = {}) {
      const crm = spyD1(pair.d1)
      const control = spyD1(o.control ?? pair.control)
      const run = await driver.run({ ...o, crm: crm.d1, control: control.d1 })
      return { ...run, writes: [...crm.log.statements, ...control.log.statements].filter((s) => WRITE.test(s) && !LIBRARY_SWEEP.test(s)) }
    }
    const sendsNoToken = async () => {
      expect(await rows(pair.control, 'select count(*) n from auth_verifications')).toEqual([{ n: 0 }])
    }

    describe('2. refusals and targeting: refused before any write', () => {
      const refusal = async (o: Parameters<typeof drive>[0], match: RegExp) => {
        const r = await drive(o)
        expect(r.code, allText(r)).toBe(driver.refused)
        expect(allText(r)).toMatch(match)
        expect(r.writes).toEqual([])
        expect(allText(r)).not.toMatch(/token=/)
        await sendsNoToken()
        expect(await rows(pair.control, "select id from control_audit where action in ('user.reset_link_issued', 'invitation.created', 'invitation.revoked')")).toEqual([])
      }

      it('provider clerk: recover through Clerk', async () => {
        await seed([{ email: 'o@x.test' }])
        await refusal({ record: { provider: 'clerk' } }, /clerk/i)
      })
      it('provider none: there are no human accounts to recover', async () => {
        await seed([{ email: 'o@x.test' }])
        await refusal({ record: { provider: 'none' } }, /none|better-auth/i)
      })
      it('no control binding', async () => {
        await seed([{ email: 'o@x.test' }])
        await refusal({ record: { control: false } }, /control/i)
      })
      it('no PUBLIC_BASE_URL', async () => {
        await seed([{ email: 'o@x.test' }])
        await refusal({ record: { baseUrl: null } }, /PUBLIC_BASE_URL/)
      })
      it('no AUTH_SECRET in the secrets file: the refusal names the file state (OPS249 D3 state d)', async () => {
        await seed([{ email: 'o@x.test' }])
        await refusal({ record: { secret: null } }, /AUTH_SECRET/)
      })
      it('an AUTH_SECRET shorter than the Worker accepts is refused (it cannot be the Worker\'s value), and the value is never printed', async () => {
        await seed([{ email: 'o@x.test' }])
        await refusal({ record: { secret: 'short-secret-value' } }, /shorter than 32/)
        const r = await drive({ record: { secret: 'short-secret-value' } })
        expect(allText(r)).not.toContain('short-secret-value')
      })
      it('several better-auth owners without --email: refused, listing their emails', async () => {
        await seed([{ email: 'a@x.test' }, { email: 'b@x.test' }])
        await refusal({}, /a@x\.test[\s\S]*b@x\.test|b@x\.test[\s\S]*a@x\.test/)
      })
      it('--email naming someone who is not an owner', async () => {
        await seed([{ email: 'a@x.test' }])
        await refusal({ email: 'stranger@x.test' }, /stranger@x\.test/)
      })
      it('owners exist but none on better-auth: recover through that provider, no invitation', async () => {
        await seed([{ email: 'c@x.test', provider: 'clerk' }])
        await refusal({ email: 'new@x.test' }, /clerk/i)
        expect(await rows(pair.control, 'select id from invitations')).toEqual([])
      })
      it('no owner and no --email', async () => {
        await seed([])
        await refusal({}, /--email/)
      })
      it('issueResetToken answers null (no Better Auth account for that owner): refused, nothing written', async () => {
        await seed([{ email: 'ghost@x.test', account: false }])
        await refusal({}, /ghost@x\.test/)
      })
      if (opts.dryRun) it('--dry-run reads only: it names the path, writes nothing and prints no token or URL', async () => {
        const { owners } = await seed([{ email: 'a@x.test' }])
        const reset = await drive({ dryRun: true })
        expect(reset.code, allText(reset)).toBe(0)
        expect(allText(reset)).toContain(owners[0]!.email)
        expect(allText(reset)).toMatch(/reset/)
        expect(reset.writes).toEqual([])
        expect(allText(reset)).not.toMatch(/token=|https?:\/\//)
        await sendsNoToken()
        await pair.reset()
        await seed([])
        const invite = await drive({ dryRun: true, email: 'first@x.test' })
        expect(invite.code, allText(invite)).toBe(0)
        expect(allText(invite)).toMatch(/invitation[\s\S]*first@x\.test|first@x\.test[\s\S]*invitation/)
        expect(invite.writes).toEqual([])
        expect(allText(invite)).not.toMatch(/token=|https?:\/\//)
        expect(await rows(pair.control, 'select id from invitations')).toEqual([])
      })
    })

    describe('3. the reset link works and is accounted for', () => {
      it('the single better-auth owner needs no --email; the printed link sets a password on the real handler, sign-in with it succeeds, and the old one stops working', async () => {
        const { system, owners } = await seed([{ email: 'owner@x.test' }])
        const r = await drive()
        expect(r.code, allText(r)).toBe(0)
        const links = r.out.filter((l) => l.includes('/reset-password#token='))
        expect(links).toHaveLength(1)
        const url = links[0]!.match(/https:\/\/\S+/)![0]
        expect(url.startsWith(`${BASE}/reset-password#token=`)).toBe(true)
        const token = new URL(url).hash.replace(/^#token=/, '')
        expect(token.length).toBeGreaterThan(8)
        expect(links[0]).toMatch(/expires \d{4}-\d{2}-\d{2}T/)
        expect(r.writes.every((w) => !/\b(memberships|users|principals|events)\b/.test(w))).toBe(true)
        const reset = await kit.call('/auth/reset-password', { body: { newPassword: NEW_PASSWORD, token } })
        expect(reset.status).toBe(200)
        expect((await kit.call('/auth/sign-in/email', { body: { email: 'owner@x.test', password: NEW_PASSWORD } })).status).toBe(200)
        expect((await kit.call('/auth/sign-in/email', { body: { email: 'owner@x.test', password: 'a long enough password 123' } })).status).not.toBe(200)
        // the audit row: system actor, the Better Auth user as target, the expiry and the way it was issued, never the token
        const audit = await rows(pair.control, "select * from control_audit where action = 'user.reset_link_issued'")
        expect(audit).toHaveLength(1)
        expect(audit[0]).toMatchObject({ actor_id: system, target_type: 'user', target_id: owners[0]!.subject })
        const detail = JSON.parse(audit[0]!.detail)
        expect(detail).toEqual({ expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), via: 'owner-reset' })
        expect(links[0]).toContain(detail.expires_at)
        // the token appears nowhere else: no output line but the one link, no CRM row, no audit row, no invitation (the library's own verification row is the one place it lives)
        expect(allText(r).split(token)).toHaveLength(2)
        expect(await dump(pair.d1)).not.toContain(token)
        expect(await dump(pair.control, ['auth_verifications'])).not.toContain(token)
        expect(JSON.stringify(r.writes)).not.toContain(token)
      })

      it('with several owners, --email picks one', async () => {
        const { owners } = await seed([{ email: 'a@x.test' }, { email: 'b@x.test' }])
        const r = await drive({ email: 'B@X.test' })
        expect(r.code, allText(r)).toBe(0)
        const links = r.out.filter((l) => l.includes('/reset-password#token='))
        expect(links).toHaveLength(1)
        expect(links[0]).toContain('b@x.test')
        expect(allText(r)).not.toContain('a@x.test')
        const audit = await rows(pair.control, "select target_id from control_audit where action = 'user.reset_link_issued'")
        expect(audit).toEqual([{ target_id: owners[1]!.subject }])
      })

      it('P3 (a): a failing audit write prints nothing, exits with the after-write code, and the unused verification row is the only trace', async () => {
        await seed([{ email: 'owner@x.test' }])
        const r = await drive({ control: failingAudit(pair.control) })
        expect(r.code, allText(r)).toBe(driver.failed)
        expect(r.out.filter((l) => /token=|https?:\/\//.test(l))).toEqual([])
        expect(allText(r)).not.toMatch(/token=/)
        const [row] = await rows(pair.control, 'select identifier from auth_verifications')
        expect(row).toBeDefined()
        // the token is in no output, not even an error line
        expect(allText(r)).not.toContain(String(row!.identifier).replace(/^reset-password:/, ''))
        expect(await rows(pair.control, "select id from control_audit where action = 'user.reset_link_issued'")).toEqual([])
        // the next run issues a new link
        const again = await drive()
        expect(again.code, allText(again)).toBe(0)
        expect(again.out.filter((l) => l.includes('/reset-password#token='))).toHaveLength(1)
      })
    })

    describe('4. the no-owner path: an owner invitation', () => {
      it('revokes the prior live owner invitations with audit rows; the printed token is accepted by the sign-up gate, printed once and stored nowhere', async () => {
        const { system } = await seed([])
        const c = openControlDb(pair.control)
        const now = new Date().toISOString()
        const expires = new Date(Date.now() + 86_400_000).toISOString()
        const old = ['old1@x.test', 'old2@x.test'].map((email, i) => ({ id: uuidv7(), auditId: uuidv7(), organizationId: uuidv7(), email, role: 'owner' as const, tokenHash: `${String(i)}`.padStart(64, 'b'), expiresAt: expires, createdBy: system, now }))
        for (const o of old) expect(await createInvitation(c, o)).toBe('created')
        const r = await drive({ email: 'New@X.test' })
        expect(r.code, allText(r)).toBe(0)
        const links = r.out.filter((l) => l.includes('/invite#token='))
        expect(links).toHaveLength(1)
        const token = new URL(links[0]!.match(/https:\/\/\S+/)![0]).hash.replace(/^#token=/, '')
        expect(links[0]!.match(/https:\/\/\S+/)![0].startsWith(`${BASE}/invite#token=`)).toBe(true)
        expect(await hasLiveInvitationForToken(c, { tokenHash: sha256(token), email: 'new@x.test', now: new Date().toISOString() })).toBe(true)
        expect(await hasLiveInvitationForToken(c, { tokenHash: sha256(token), email: 'other@x.test', now: new Date().toISOString() })).toBe(false)
        expect((await rows(pair.control, "select id from invitations where role = 'owner' and accepted_at is null and revoked_at is null")).length).toBe(1)
        const revoked = await rows(pair.control, "select target_id, actor_id from control_audit where action = 'invitation.revoked' order by target_id")
        expect(revoked.map((x) => x.target_id).sort()).toEqual(old.map((o) => o.id).sort())
        expect(revoked.every((x) => x.actor_id === system)).toBe(true)
        expect((await rows(pair.control, "select actor_id from control_audit where action = 'invitation.created' and target_id not in (?, ?)", old[0]!.id, old[1]!.id))[0]!.actor_id).toBe(system)
        expect(allText(r).split(token)).toHaveLength(2)
        expect(await dump(pair.d1)).not.toContain(token)
        expect(await dump(pair.control)).not.toContain(token)
        expect(r.writes.every((w) => !/\b(memberships|users|principals|events|organizations)\b/.test(w))).toBe(true)
        // no Better Auth verification row, no CRM write: the invitation path never composes Better Auth
        await sendsNoToken()
      })

      it('with no prior invitation the run only creates one', async () => {
        await seed([])
        const r = await drive({ email: 'first@x.test' })
        expect(r.code, allText(r)).toBe(0)
        expect(await rows(pair.control, "select id from control_audit where action = 'invitation.revoked'")).toEqual([])
        expect(await rows(pair.control, "select id from control_audit where action = 'invitation.created'")).toHaveLength(1)
      })

      it('a live invitation of another role for the same address refuses the run and leaves the owner invitations live', async () => {
        const { system } = await seed([])
        const c = openControlDb(pair.control)
        const base = { organizationId: uuidv7(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdBy: system, now: new Date().toISOString() }
        await createInvitation(c, { ...base, id: uuidv7(), auditId: uuidv7(), email: 'x@x.test', role: 'member', tokenHash: 'c'.repeat(64) })
        await createInvitation(c, { ...base, id: uuidv7(), auditId: uuidv7(), email: 'other-owner@x.test', role: 'owner', tokenHash: 'd'.repeat(64) })
        const r = await drive({ email: 'x@x.test' })
        expect(r.code, allText(r)).toBe(driver.refused)
        expect(allText(r)).toMatch(/x@x\.test/)
        expect((await rows(pair.control, "select id from invitations where role = 'owner' and revoked_at is null")).length).toBe(1)
        expect(await rows(pair.control, "select id from control_audit where action = 'invitation.revoked'")).toEqual([])
      })
    })
  })
}
