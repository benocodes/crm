import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { StatementFailed, type PreparedOperation, type StatementLabel } from '@vault/storage'
import { withFault } from '@vault/storage/test'
import { deleteCompanyOperation, deleteContactOperation } from '../identity/cascades.js'
import { mergeOperation } from '../identity/merge.js'
import { ensureOwnIdentity, resolveOperation } from '../identity/resolve.js'
import { identities } from '../resources/identities.js'
import { openEngines, type Engine } from '../test/engines.js'
import { BASE, identityKit, type IdentityKit } from '../test/identity-kit.js'
import { createOperation, deleteOperation } from './crud.js'

// Cross-cutting acceptance rows of CORE36 on both engines: clock parity (D2), constant statement counts (D5),
// over-cap refusal (D14), atomicity, and the D1 drift cases (D4, issue #18). RESULT.md records the counts.
const at = (n: number) => new Date(BASE + n * 60_000)
const iso = (n: number) => at(n).toISOString()
const TABLES = ['companies', 'contacts', 'identities', 'events'] as const
const snapshot = async (e: Engine) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await e.rows(t)] as const)))

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('identity model storage behaviour on %s', (name) => {
  let e: Engine
  let k: IdentityKit
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    k = identityKit(e)
  })

  describe('clock parity (D2): every stamp is the unit clock, the response and the event agree', () => {
    const eventsAt = async (n: number) => (await e.rows('events')).filter((x) => x.created_at === iso(n))

    it('create, update and delete of companies, contacts and identities', async () => {
      const co = await k.company({ name: 'C', domain: 'c.com' }, { now: at(1) })
      expect(co).toMatchObject({ created_at: iso(1), updated_at: iso(1) })
      expect((await eventsAt(1))[0]).toMatchObject({ type: 'company.created', after: co })

      const co2 = await k.updateCompany(co.id, { name: 'C2' }, { now: at(2) })
      expect(co2).toMatchObject({ created_at: iso(1), updated_at: iso(2) })
      expect(await k.row('companies', co.id)).toMatchObject({ updated_at: iso(2) })
      expect((await eventsAt(2))[0]).toMatchObject({ type: 'company.updated', after: co2 })

      const ct = await k.contact({ company_id: co.id }, { now: at(3) })
      expect(ct).toMatchObject({ created_at: iso(3), updated_at: iso(3) })
      const id = await k.identity({ kind: 'email', value: 'a@b.com', contact_id: ct.id }, { now: at(4) })
      expect(id).toMatchObject({ created_at: iso(4), updated_at: iso(4) })
      const id2 = await k.updateIdentity(id.id, { own: true }, { now: at(5) })
      expect(id2).toMatchObject({ updated_at: iso(5) })
      expect((await eventsAt(5))[0]).toMatchObject({ type: 'identity.updated', after: id2 })

      await k.deleteCompany(co.id, { now: at(6) })
      expect(await k.row('companies', co.id)).toMatchObject({ deleted_at: iso(6), updated_at: iso(6) })
      expect(await k.row('contacts', ct.id)).toMatchObject({ company_id: null, updated_at: iso(6), deleted_at: null })
      expect((await eventsAt(6)).map((x) => x.type)).toEqual(['company.deleted', 'contact.updated'])
      expect((await eventsAt(6))[1]!.after).toMatchObject({ updated_at: iso(6) })

      await k.deleteContact(ct.id, { now: at(7) })
      expect(await k.row('contacts', ct.id)).toMatchObject({ deleted_at: iso(7), updated_at: iso(7) })
      expect(await k.row('identities', id.id)).toMatchObject({ deleted_at: iso(7), updated_at: iso(7) })
      expect((await eventsAt(7)).map((x) => x.type)).toEqual(['contact.deleted', 'identity.deleted'])

      const lone = await k.identity({ kind: 'email', value: 'lone@b.com', own: true }, { now: at(8) })
      await k.run((env) => deleteOperation(identities, env, lone.id), { now: at(9) })
      expect(await k.row('identities', lone.id)).toMatchObject({ deleted_at: iso(9), updated_at: iso(9) })
    })

    it('resolve, ensure-own and merge', async () => {
      const out = await k.run((env) => resolveOperation(env, [{ kind: 'email', value: 'r@b.com', name: 'R' }]), { now: at(1) })
      expect(out[0]!.identity).toMatchObject({ created_at: iso(1), updated_at: iso(1) })
      expect(out[0]!.contact).toMatchObject({ created_at: iso(1), updated_at: iso(1) })
      const stored = await k.row('identities', out[0]!.identity.id)
      expect(stored).toMatchObject({ created_at: iso(1), updated_at: iso(1) })
      expect((await eventsAt(1)).map((x) => x.type)).toEqual(['contact.created', 'identity.created'])

      const moved = await k.run((env) => ensureOwnIdentity(env, { kind: 'email', value: 'r@b.com' }), { now: at(2) })
      expect(moved.identity).toMatchObject({ updated_at: iso(2), own: true })
      const made = await k.run((env) => ensureOwnIdentity(env, { kind: 'email', value: 'own@b.com' }), { now: at(3) })
      expect(made.identity).toMatchObject({ created_at: iso(3), updated_at: iso(3) })

      const s = await k.contact({}, { now: at(4) })
      const r = await k.contact({ name: 'Rita' }, { now: at(4) })
      const i = await k.identity({ kind: 'email', value: 'm@b.com', contact_id: r.id }, { now: at(4) })
      const survivor = await k.run((env) => mergeOperation(env, s.id, r.id), { now: at(5) })
      expect(survivor).toMatchObject({ name: 'Rita', updated_at: iso(5) })
      expect(await k.row('identities', i.id)).toMatchObject({ contact_id: s.id, updated_at: iso(5) })
      expect(await k.row('contacts', r.id)).toMatchObject({ deleted_at: iso(5), updated_at: iso(5), merged_into_id: s.id })
      const ev = await eventsAt(5)
      expect(ev.map((x) => x.type)).toEqual(['identity.updated', 'contact.updated', 'contact.merged'])
      expect(ev[2]!.after).toMatchObject({ deleted_at: iso(5), updated_at: iso(5), merged_into_id: s.id })
    })
  })

  describe('constant statement counts (D5)', () => {
    const counts: Record<string, number[]> = {}
    const measure = async (label: string, size: number, run: () => Promise<{ stats: { statements: number } }>) => {
      const res = await run()
      ;(counts[label] ??= []).push(res.stats.statements)
      return res
    }
    afterAll(() => {
      for (const [label, [one, ten]] of Object.entries(counts)) console.log(`[statements] ${name} ${label}: set of 1 -> ${one}, set of 10 -> ${ten}`)
    })

    const setup = {
      'company delete': async (n: number) => {
        const co = await k.company({ name: 'C' })
        for (let i = 0; i < n; i++) await k.contact({ company_id: co.id })
        return () => e.run(deleteCompanyOperation(k.env(), co.id))
      },
      'contact delete': async (n: number) => {
        const c = await k.contact({})
        for (let i = 0; i < n; i++) await k.identity({ kind: 'email', value: `d${i}@b.com`, contact_id: c.id })
        return () => e.run(deleteContactOperation(k.env(), c.id))
      },
      merge: async (n: number) => {
        const s = await k.contact({})
        const r = await k.contact({ name: 'R' })
        for (let i = 0; i < n; i++) await k.identity({ kind: 'email', value: `m${i}@b.com`, contact_id: r.id })
        return () => e.run(mergeOperation(k.env(), s.id, r.id))
      },
      resolve: async (n: number) =>
        () => e.run(resolveOperation(k.env(), Array.from({ length: n }, (_, i) => ({ kind: 'email' as const, value: `n${i}@b.com`, name: `N${i}` })))),
    }
    it.each(Object.keys(setup) as Array<keyof typeof setup>)('%s costs the same statements for a set of 1 and a set of 10', async (label) => {
      for (const size of [1, 10]) {
        await e.reset()
        k = identityKit(e)
        const run = await setup[label](size)
        await measure(label, size, run)
      }
      expect(counts[label]![0]).toBeGreaterThan(0)
      expect(counts[label]![1]).toBe(counts[label]![0])
    })
  })

  describe('atomicity: a failure at the first mutation, first event or result rolls everything back', () => {
    const labels: StatementLabel[] = ['first-mutation', 'first-event', 'result']
    const cases: Record<string, () => Promise<() => PreparedOperation<unknown>>> = {
      resolve: async () => () => resolveOperation(k.env(), [{ kind: 'email', value: 'new@b.com', name: 'N' }]),
      merge: async () => {
        const s = await k.contact({})
        const r = await k.contact({ name: 'R' })
        await k.identity({ kind: 'email', value: 'm@b.com', contact_id: r.id })
        return () => mergeOperation(k.env(), s.id, r.id)
      },
      'company delete': async () => {
        const co = await k.company({ name: 'C' })
        await k.contact({ company_id: co.id })
        return () => deleteCompanyOperation(k.env(), co.id)
      },
      'contact delete': async () => {
        const c = await k.contact({})
        await k.identity({ kind: 'email', value: 'd@b.com', contact_id: c.id })
        return () => deleteContactOperation(k.env(), c.id)
      },
    }
    for (const [label, prepare] of Object.entries(cases)) {
      it.each(labels)(`${label}: a real constraint fault after %s changes nothing`, async (after) => {
        const make = await prepare()
        const before = await snapshot(e)
        const err = await e.run(withFault(make(), { after })).then(() => null, (x: unknown) => x)
        expect(err).toBeInstanceOf(StatementFailed)
        expect(await snapshot(e)).toEqual(before)
      })
    }
  })

  if (name === 'd1') {
    describe('D1 drift: what changed between the plan and the commit batch aborts the unit (D4, issue #18)', () => {
      const live = async (contactId: string) => (await e.rows('identities')).filter((i) => i.contact_id === contactId && i.deleted_at === null)

      it('an identity create racing a merge of its contact: 409 conflict, nothing live on the tombstone, the retry is invalid_reference', async () => {
        const s = await k.contact({})
        const r = await k.contact({})
        e.betweenPlanAndCommit(async () => {
          await e.run(mergeOperation(k.env(), s.id, r.id))
        })
        const err = await k.fail((env) => createOperation(identities, env, { kind: 'email', value: 'late@b.com', contact_id: r.id }))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect(await live(r.id)).toHaveLength(0)
        const retry = await k.fail((env) => createOperation(identities, env, { kind: 'email', value: 'late@b.com', contact_id: r.id }))
        expect(retry.code).toBe('invalid_reference')
      })

      it('a merge racing an identity create on the source: 409 conflict, the source stays live and nothing moved', async () => {
        const s = await k.contact({})
        const r = await k.contact({})
        await k.identity({ kind: 'email', value: 'm@b.com', contact_id: r.id })
        const before = await snapshot(e)
        e.betweenPlanAndCommit(async () => {
          await e.insert('identities', { kind: 'email', value: 'sneak@b.com', contact_id: r.id, own: false })
        })
        const err = await k.fail((env) => mergeOperation(env, s.id, r.id))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect((await k.row('contacts', r.id)).deleted_at).toBeNull()
        expect((await e.rows('identities')).filter((i) => i.contact_id === s.id)).toHaveLength(0)
        expect(await e.rows('events')).toEqual(before.events)
      })

      it('a merge racing the deletion of its survivor: 409 conflict, the source stays live', async () => {
        const s = await k.contact({})
        const r = await k.contact({})
        await k.identity({ kind: 'email', value: 'm@b.com', contact_id: r.id })
        e.betweenPlanAndCommit(async () => {
          await e.run(deleteContactOperation(k.env(), s.id))
        })
        const err = await k.fail((env) => mergeOperation(env, s.id, r.id))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect((await k.row('contacts', r.id)).deleted_at).toBeNull()
        expect((await live(r.id)).length).toBe(1)
      })

      it('a company delete racing a new contact on the company: 409 conflict, company and contacts unchanged (exactly count)', async () => {
        const co = await k.company({ name: 'C' })
        await k.contact({ company_id: co.id })
        const before = await snapshot(e)
        e.betweenPlanAndCommit(async () => {
          await e.insert('contacts', { company_id: co.id })
        })
        const err = await k.fail((env) => deleteCompanyOperation(env, co.id))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect((await k.row('companies', co.id)).deleted_at).toBeNull()
        expect((await e.rows('contacts')).filter((c) => c.company_id === co.id)).toHaveLength(2)
        expect(await e.rows('events')).toEqual(before.events)
      })

      it('a unique-index race maps to conflict and leaves no orphan contact', async () => {
        const other = await k.contact({})
        e.betweenPlanAndCommit(async () => {
          await e.insert('identities', { kind: 'email', value: 'x@y.com', contact_id: other.id, own: false })
        })
        const err = await k.fail((env) => resolveOperation(env, [{ kind: 'email', value: 'x@y.com', name: 'Late' }]))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect(await k.count('identities')).toBe(1)
        expect(await k.count('contacts')).toBe(1) // only `other`: the resolve's new contact rolled back with its identity
      })

      it('the same race on a plain identity create is a conflict, and the retry gets identity_exists', async () => {
        const c = await k.contact({})
        const other = await k.contact({})
        e.betweenPlanAndCommit(async () => {
          await e.insert('identities', { kind: 'email', value: 'x@y.com', contact_id: other.id, own: false })
        })
        const err = await k.fail((env) => createOperation(identities, env, { kind: 'email', value: 'x@y.com', contact_id: c.id }))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        const retry = await k.fail((env) => createOperation(identities, env, { kind: 'email', value: 'x@y.com', contact_id: c.id }))
        expect(retry.code).toBe('identity_exists')
      })
    })
  }
})

// ---- over the cap (D14): refused at a small runtime cap, the same programs pass at a larger one ----------------
describe.each(['postgres', 'd1'] as const)('over-cap refusal on %s', (name) => {
  let small: Engine
  let big: Engine
  const smalls: Engine[] = []
  beforeAll(async () => {
    smalls.push(...(await openEngines({ maxSetSize: 3 })), ...(await openEngines({ maxSetSize: 10 })))
    small = smalls.find((x, i) => x.name === name && i < 2)!
    big = smalls.find((x, i) => x.name === name && i >= 2)!
  })
  afterAll(async () => {
    for (const x of smalls) await x.close()
  })

  const cases: Record<string, (e: Engine, k: IdentityKit) => Promise<() => PreparedOperation<unknown>>> = {
    'company delete (4 live contacts)': async (_e, k) => {
      const co = await k.company({ name: 'C' })
      for (let i = 0; i < 4; i++) await k.contact({ company_id: co.id })
      return () => deleteCompanyOperation(k.env(), co.id)
    },
    'contact delete (4 identities)': async (_e, k) => {
      const c = await k.contact({})
      for (let i = 0; i < 4; i++) await k.identity({ kind: 'email', value: `d${i}@b.com`, contact_id: c.id })
      return () => deleteContactOperation(k.env(), c.id)
    },
    'merge (source with 4 identities)': async (_e, k) => {
      const s = await k.contact({})
      const r = await k.contact({})
      for (let i = 0; i < 4; i++) await k.identity({ kind: 'email', value: `m${i}@b.com`, contact_id: r.id })
      return () => mergeOperation(k.env(), s.id, r.id)
    },
    'resolve (4 new addresses)': async (_e, k) => () => resolveOperation(k.env(), Array.from({ length: 4 }, (_, i) => ({ kind: 'email' as const, value: `n${i}@b.com` }))),
  }
  for (const [label, prepare] of Object.entries(cases)) {
    it(`${label}: 400 set_limit_exceeded at cap 3 changes nothing; the same program passes at cap 10`, async () => {
      await small.reset()
      const ks = identityKit(small)
      const make = await prepare(small, ks)
      const before = await snapshot(small)
      const err = await ks.fail(() => make())
      expect([err.status, err.code]).toEqual([400, 'set_limit_exceeded'])
      expect(await snapshot(small)).toEqual(before)

      await big.reset()
      const kb = identityKit(big)
      const makeBig = await prepare(big, kb)
      await expect(big.run(makeBig())).resolves.toBeDefined()
    })
  }
})
