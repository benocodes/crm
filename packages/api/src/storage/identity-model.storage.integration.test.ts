import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { StatementFailed, type PreparedOperation, type StatementLabel } from '@vault/storage'
import { withFault } from '@vault/storage/test'
import { deleteCompanyOperation, deleteContactOperation } from '../identity/cascades.js'
import { mergeOperation } from '../identity/merge.js'
import { ensureOwnIdentity, resolveOperation } from '../identity/resolve.js'
import { companyFiles } from '../resources/company-files.js'
import { contactFiles } from '../resources/contact-files.js'
import { identities } from '../resources/identities.js'
import { seedConversation } from '../test/messaging-kit.js'
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
      const movable = await k.identity({ kind: 'email', value: 'move@b.com', contact_id: ct.id }, { now: at(4) })
      const id2 = await k.updateIdentity(movable.id, { own: true }, { now: at(5) })
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
      expect(await k.row('identities', movable.id)).toMatchObject({ deleted_at: null, updated_at: iso(5) }) // moved to own at t5: not the contact's any more

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
      expect(ev[2]!.after).toMatchObject({ updated_at: iso(5), merged_into_id: s.id })
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
      'contact delete with links': async (n: number) => {
        const c = await k.contact({})
        for (let i = 0; i < n; i++) await k.identity({ kind: 'email', value: `dl${i}@b.com`, contact_id: c.id })
        const { fileIds } = await seedConversation((t, r) => e.insert(t, r), { attachments: n })
        for (const f of fileIds) await k.run((env) => createOperation(contactFiles, env, { contact_id: c.id, file_id: f }))
        return () => e.run(deleteContactOperation(k.env(), c.id))
      },
      'company delete with links': async (n: number) => {
        const co = await k.company({ name: 'C' })
        for (let i = 0; i < n; i++) await k.contact({ company_id: co.id })
        const { fileIds } = await seedConversation((t, r) => e.insert(t, r), { attachments: n })
        for (const f of fileIds) await k.run((env) => createOperation(companyFiles, env, { company_id: co.id, file_id: f }))
        return () => e.run(deleteCompanyOperation(k.env(), co.id))
      },
      'merge with links': async (n: number) => {
        const s = await k.contact({})
        const r = await k.contact({ name: 'R' })
        for (let i = 0; i < n; i++) await k.identity({ kind: 'email', value: `ml${i}@b.com`, contact_id: r.id })
        const { fileIds } = await seedConversation((t, row) => e.insert(t, row), { attachments: n })
        for (const f of fileIds) await k.run((env) => createOperation(contactFiles, env, { contact_id: r.id, file_id: f }))
        for (const f of fileIds.slice(0, Math.floor(n / 2))) await k.run((env) => createOperation(contactFiles, env, { contact_id: s.id, file_id: f })) // half duplicate the source's
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

      it('a company delete where a planned contact is swapped for an unplanned one (same count): 409 conflict, nothing changes', async () => {
        const co = await k.company({ name: 'C' })
        const a = await k.contact({ company_id: co.id })
        const before = await snapshot(e)
        let b: Record<string, any> | undefined
        e.betweenPlanAndCommit(async () => {
          await e.run(deleteContactOperation(k.env(), a.id))
          b = await e.insert('contacts', { company_id: co.id })
        })
        const err = await k.fail((env) => deleteCompanyOperation(env, co.id))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect((await k.row('companies', co.id)).deleted_at).toBeNull()
        expect((await k.row('contacts', b!.id)).company_id).toBe(co.id)
        expect((await k.row('contacts', b!.id)).deleted_at).toBeNull()
        // only the hook's own contact.deleted was added
        expect((await e.rows('events')).slice(before.events.length).map((x) => x.type)).toEqual(['contact.deleted'])
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

// ---- CORE25: merge and cascades are aware of the file links (D35, P12, P13) --------------------------------------------
describe.each(['postgres', 'd1'] as const)('merge and delete with file links on %s', (name) => {
  let e: Engine
  let k: IdentityKit
  const seedFiles = async (n: number) => (await seedConversation((t, r) => e.insert(t, r), { attachments: n })).fileIds
  const link = (contactId: string, fileId: string) => k.run((env) => createOperation(contactFiles, env, { contact_id: contactId, file_id: fileId }))
  const companyLink = (companyId: string, fileId: string) => k.run((env) => createOperation(companyFiles, env, { company_id: companyId, file_id: fileId }))
  const mergeAt = (s: string, r: string, n: number) => k.run((env) => mergeOperation(env, s, r), { now: at(n) })
  const evAfter = async (count: number) => (await e.rows('events')).slice(count)
  const linkRows = async (contactId: string) => (await e.rows('contact_files')).filter((x) => x.contact_id === contactId)
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    k = identityKit(e)
  })

  it('merge re-points links, soft-deleting the duplicates, in the documented event order', async () => {
    const [F1, F2] = await seedFiles(2)
    const S = await k.contact({})
    const R = await k.contact({})
    const i = await k.identity({ kind: 'email', value: 'r@b.com', contact_id: R.id })
    const rF1 = await link(R.id, F1!)
    const rF2 = await link(R.id, F2!)
    await link(S.id, F2!)
    const count = (await e.rows('events')).length
    await mergeAt(S.id, R.id, 50)
    const live = (await linkRows(S.id)).filter((x) => x.deleted_at === null)
    expect(live.map((x) => x.file_id).sort()).toEqual([F1, F2].sort())
    const rowF2 = (await e.rows('contact_files')).find((x) => x.id === rF2.id)!
    expect(rowF2).toMatchObject({ contact_id: R.id, deleted_at: at(50).toISOString(), updated_at: at(50).toISOString() })
    expect((await e.rows('contact_files')).find((x) => x.id === rF1.id)).toMatchObject({ contact_id: S.id, updated_at: at(50).toISOString(), deleted_at: null })
    const evs = await evAfter(count)
    expect(evs.map((x) => x.type)).toEqual(['identity.updated', 'contact_file.deleted', 'contact_file.updated', 'contact.merged'])
    expect(evs[0]).toMatchObject({ resource_id: i.id })
    expect(evs[1]).toMatchObject({ resource_id: rF2.id, after: null, before: rF2 })
    expect(evs[2]).toMatchObject({ resource_id: rF1.id, before: rF1 })
    expect(evs[2]!.after).toMatchObject({ contact_id: S.id })
    for (const x of evs) expect(x.actor_id).toBe(e.userId)
  })

  it('a merge with no links emits no contact_file events', async () => {
    const S = await k.contact({})
    const R = await k.contact({})
    await k.identity({ kind: 'email', value: 'r@b.com', contact_id: R.id })
    const count = (await e.rows('events')).length
    await mergeAt(S.id, R.id, 51)
    expect((await evAfter(count)).map((x) => x.type)).toEqual(['identity.updated', 'contact.merged'])
  })

  it('a merge where every source link duplicates the survivor emits one deleted and no updated', async () => {
    const [F2] = await seedFiles(1)
    const S = await k.contact({})
    const R = await k.contact({})
    await link(R.id, F2!)
    await link(S.id, F2!)
    const count = (await e.rows('events')).length
    await mergeAt(S.id, R.id, 52)
    expect((await evAfter(count)).map((x) => x.type)).toEqual(['contact_file.deleted', 'contact.merged'])
    expect((await linkRows(S.id)).filter((x) => x.deleted_at === null)).toHaveLength(1)
  })

  it('contact delete tombstones identities then live links; an already deleted link is untouched', async () => {
    const [F1, F2] = await seedFiles(2)
    const K = await k.contact({})
    await k.identity({ kind: 'email', value: 'k1@b.com', contact_id: K.id })
    await k.identity({ kind: 'email', value: 'k2@b.com', contact_id: K.id })
    const old = await link(K.id, F1!)
    await k.run((env) => deleteOperation(contactFiles, env, old.id), { now: at(60) })
    const live = await link(K.id, F2!)
    const count = (await e.rows('events')).length
    await k.deleteContact(K.id, { now: at(61) })
    expect((await evAfter(count)).map((x) => x.type)).toEqual(['contact.deleted', 'identity.deleted', 'identity.deleted', 'contact_file.deleted'])
    const rows = await e.rows('contact_files')
    expect(rows.find((x) => x.id === old.id)!.deleted_at).toBe(at(60).toISOString())
    expect(rows.find((x) => x.id === live.id)!.deleted_at).toBe(at(61).toISOString())
  })

  it('company delete unlinks contacts then tombstones links', async () => {
    const [F1, F2] = await seedFiles(2)
    const Co = await k.company({ name: 'Co' })
    await k.contact({ company_id: Co.id })
    await k.contact({ company_id: Co.id })
    await companyLink(Co.id, F1!)
    await companyLink(Co.id, F2!)
    const count = (await e.rows('events')).length
    await k.deleteCompany(Co.id, { now: at(62) })
    expect((await evAfter(count)).map((x) => x.type)).toEqual(['company.deleted', 'contact.updated', 'contact.updated', 'company_file.deleted', 'company_file.deleted'])
    expect((await e.rows('company_files')).every((x) => x.deleted_at === at(62).toISOString())).toBe(true)
  })

  if (name === 'd1') {
    describe('D1 drift: what changed between plan and commit aborts the unit', () => {
      it('merge: the survivor gains a link to a file the source also links', async () => {
        const [F1] = await seedFiles(1)
        const S = await k.contact({})
        const R = await k.contact({})
        await link(R.id, F1!)
        const before = Object.fromEntries(await Promise.all(['contact_files', 'events', 'contacts'].map(async (t) => [t, await e.rows(t)] as const)))
        e.betweenPlanAndCommit(async () => {
          await e.insert('contact_files', { contact_id: S.id, file_id: F1 })
        })
        const err = await k.fail((env) => mergeOperation(env, S.id, R.id))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect((await e.rows('events'))).toEqual(before.events)
        expect((await e.rows('contacts'))).toEqual(before.contacts)
        expect((await e.rows('contact_files')).length).toBe(before.contact_files!.length + 1)
      })
      it('merge: the source gains a link', async () => {
        const [F1, F3] = await seedFiles(2)
        const S = await k.contact({})
        const R = await k.contact({})
        await link(R.id, F1!)
        const events = (await e.rows('events')).length
        e.betweenPlanAndCommit(async () => {
          await e.insert('contact_files', { contact_id: R.id, file_id: F3 })
        })
        const err = await k.fail((env) => mergeOperation(env, S.id, R.id))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect((await e.rows('contacts')).find((x) => x.id === R.id)!.deleted_at).toBeNull()
        expect((await linkRows(S.id))).toHaveLength(0)
        expect((await e.rows('events')).length).toBe(events)
      })
      it('merge: a swap that keeps the count (one link soft-deleted, another inserted)', async () => {
        const [F1, F3] = await seedFiles(2)
        const S = await k.contact({})
        const R = await k.contact({})
        const l1 = await link(R.id, F1!)
        const events = (await e.rows('events')).length
        e.betweenPlanAndCommit(async () => {
          await e.update('contact_files', l1.id, { deleted_at: '2026-10-22T09:00:00.000Z', updated_at: '2026-10-22T09:00:00.000Z' })
          await e.insert('contact_files', { contact_id: R.id, file_id: F3 })
        })
        const err = await k.fail((env) => mergeOperation(env, S.id, R.id))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect((await e.rows('contacts')).find((x) => x.id === R.id)!.deleted_at).toBeNull()
        expect((await e.rows('events')).length).toBe(events)
      })
      it('contact delete: a link added during the delete', async () => {
        const [F1] = await seedFiles(1)
        const K = await k.contact({})
        const events = (await e.rows('events')).length
        e.betweenPlanAndCommit(async () => {
          await e.insert('contact_files', { contact_id: K.id, file_id: F1 })
        })
        const err = await k.fail((env) => deleteContactOperation(env, K.id))
        expect([err.status, err.code]).toEqual([409, 'conflict'])
        expect((await e.rows('contacts')).find((x) => x.id === K.id)!.deleted_at).toBeNull()
        expect((await e.rows('events')).length).toBe(events)
      })
    })
  }
})
