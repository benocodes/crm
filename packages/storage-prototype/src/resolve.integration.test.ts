import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { backends, harness, type Harness } from './test/backend.js'
import { exactEvents, uuidPattern } from './test/contracts.js'
for (const backend of backends)
  describe(backend, () => {
    let h: Harness
    beforeAll(async () => {
      h = await harness(backend)
    })
    afterAll(async () => {
      await h?.close()
    })
    test('first blank name wins, ordered duplicates, known reuse without orphans', async () => {
      await h.clearEvents()
      const r = await h.resolve([
        { kind: 'email', value: ' A@example.com ', name: ' ' },
        { kind: 'email', value: 'a@example.com', name: 'Later' },
        { kind: 'phone', value: '+12025550123', name: ' Person ' },
      ])
      expect(r.value.map((x) => x.created)).toEqual([true, false, true])
      expect(r.value[0].contact?.name).toBeNull()
      expect(r.value[2].contact?.name).toBe('Person')
      expect(r.value[0].identity).toEqual(r.value[1].identity)
      for (const x of r.value) {
        expect(x.identity.id).toMatch(uuidPattern)
        expect(x.identity.own).toBe(false)
      }
      await exactEvents(h, r, [
        { type: 'contact.created', before: null, after: r.value[0].contact },
        { type: 'identity.created', before: null, after: r.value[0].identity },
        { type: 'contact.created', before: null, after: r.value[2].contact },
        { type: 'identity.created', before: null, after: r.value[2].identity },
      ])
      await h.clearEvents()
      const counts = await h.counts()
      const known = await h.resolve([{ kind: 'email', value: 'a@example.com', name: 'Improve' }])
      expect(known.value[0]).toEqual({ ...r.value[0], created: false })
      expect(await h.counts()).toEqual(counts)
    })
    test('own returns boolean/null, empty returns empty', async () => {
      const own: any = await h.seed(h.a, 'identities', { kind: 'email', value: 'own@example.com', own: true })
      await h.clearEvents()
      const r = await h.resolve([{ kind: 'email', value: 'own@example.com' }])
      expect(r.value).toEqual([{ identity: own, contact: null, created: false }])
      await exactEvents(h, r, [])
      expect((await h.resolve([])).value).toEqual([])
    })
    test('100 new addresses and cleaned overlong names, exact agent attribution', async () => {
      await h.clearEvents()
      const r = await h.resolve(
        Array.from({ length: 100 }, (_, i) => ({
          kind: 'email',
          value: `bulk${i}@example.com`,
          name: 'x'.repeat(600),
        })),
        h.agentContext,
      )
      expect(r.value).toHaveLength(100)
      expect(r.value.every((x) => x.created && x.contact?.name === 'x'.repeat(500))).toBe(true)
      expect(await h.events()).toHaveLength(200)
      expect((await h.events()).every((e) => e.actor_id === h.agentContext.actor.id)).toBe(true)
    })
    test('tombstone reuse and invalid whole input preserve prior rows', async () => {
      const first = await h.resolve([{ kind: 'email', value: 'deleted@example.com' }])
      const old = first.value[0]
      if (backend === 'postgres') {
        const { withContext, deleteResource, contacts } = await import('@vault/api')
        await withContext((h as any).db, h.a, (c) => deleteResource(c, contacts, old.contact!.id))
      } else {
        const t = new Date().toISOString()
        await h.query('UPDATE identities SET deleted_at=? WHERE id=?', [t, old.identity.id])
        await h.query('UPDATE contacts SET deleted_at=? WHERE id=?', [t, old.contact!.id])
      }
      await h.clearEvents()
      const deleted = await h.query(
        `SELECT * FROM identities WHERE id=${backend === 'postgres' ? '$1' : '?'}`,
        [old.identity.id],
      )
      const r = await h.resolve([{ kind: 'email', value: 'deleted@example.com' }])
      expect(r.value[0].created).toBe(true)
      expect(r.value[0].identity.id).not.toBe(old.identity.id)
      expect(
        await h.query(`SELECT * FROM identities WHERE id=${backend === 'postgres' ? '$1' : '?'}`, [
          old.identity.id,
        ]),
      ).toEqual(deleted)
      await h.clearEvents()
      const counts = await h.counts()
      await expect(
        h.resolve([
          { kind: 'email', value: 'valid-new@example.com' },
          { kind: 'phone', value: 'bad' },
        ]),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_identity' })
      expect(await h.counts()).toEqual(counts)
    })
    test('100 repeated inputs emit exactly two events and preserve first name', async () => {
      await h.clearEvents()
      const r = await h.resolve(
        Array.from({ length: 100 }, (_, i) => ({
          kind: 'email',
          value: 'repeated@example.com',
          name: i ? 'Later' : 'First',
        })),
      )
      expect(r.value.map((x) => x.created)).toEqual([true, ...Array(99).fill(false)])
      expect(r.value.every((x) => x.contact?.name === 'First')).toBe(true)
      expect(await h.events()).toHaveLength(2)
    })
  })
