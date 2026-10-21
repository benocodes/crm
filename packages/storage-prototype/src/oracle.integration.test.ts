import { test, expect } from 'vitest'
import { withContext, updateResource, tasks, resolveIdentities } from '@vault/api'
import { postgresFixture } from './test/postgres.js'
import { backends, harness } from './test/backend.js'
import { canonicalizer } from './test/oracle.js'
import { uuid7 } from './uuid7.js'
for (const backend of backends) {
  test(`${backend}: independently reset current-service task oracle`, async () => {
    const patches = [
      { status: 'done' },
      { status: 'done' },
      { title: 'New' },
      {},
      { status: 'open' },
      { status: 'open' },
    ]
    const f = await postgresFixture()
    let expected: any[] = []
    try {
      const before: any = await f.seed()
      await f.clearEvents()
      const canonical = canonicalizer(f.a.organizationId, f.a.actor.id)
      for (const patch of patches) {
        const current = await withContext(f.db, f.a, (c) => updateResource(c, tasks, before.id, patch))
        const events = await f.query('SELECT * FROM events')
        if (Object.keys(patch).length) expect(events.at(-1).after).toEqual(current)
        expected.push(canonical({ value: current, count: events.length }))
      }
    } finally {
      await f.close()
    }
    const h = await harness(backend)
    try {
      const before: any = await h.seed()
      await h.clearEvents()
      const canonical = canonicalizer(h.a.organizationId, h.a.actor.id)
      for (const [i, patch] of patches.entries()) {
        const r = await h.task(before.id, patch)
        const events = await h.events()
        if (Object.keys(patch).length)
          expect(events.find((e) => e.id === r.eventOrder[0].id)?.after).toEqual(r.value)
        expect(canonical({ value: r.value, count: events.length })).toEqual(expected[i])
      }
      await expect(h.task(uuid7(), {})).rejects.toMatchObject({ status: 404, code: 'not_found' })
    } finally {
      await h.close()
    }
  })
  test(`${backend}: independently reset resolve oracle with exact relationships`, async () => {
    const entries = [
      { kind: 'email' as const, value: 'known@example.com', name: 'Never improve' },
      { kind: 'email' as const, value: 'own@example.com' },
      { kind: 'email' as const, value: 'oracle@example.com', name: ' ' },
      { kind: 'email' as const, value: 'ORACLE@example.com', name: 'Later' },
      { kind: 'phone' as const, value: '+12025550198', name: ' Name ' },
    ]
    const seed = async (f: any) => {
      const contact = await f.seed(f.a, 'contacts', { name: 'Existing' })
      await f.seed(f.a, 'identities', {
        kind: 'email',
        value: 'known@example.com',
        contact_id: contact.id,
        own: false,
      })
      await f.seed(f.a, 'identities', { kind: 'email', value: 'own@example.com', own: true })
      await f.clearEvents()
    }
    let expected: any
    const f = await postgresFixture()
    try {
      await seed(f)
      const value = await withContext(f.db, f.a, (c) => resolveIdentities(c, entries))
      const events = await f.query('SELECT * FROM events')
      expect(events).toHaveLength(4)
      expected = canonicalizer(f.a.organizationId, f.a.actor.id)(value)
    } finally {
      await f.close()
    }
    const h = await harness(backend)
    try {
      await seed(h)
      const r = await h.resolve(entries)
      expect(canonicalizer(h.a.organizationId, h.a.actor.id)(r.value)).toEqual(expected)
      expect(r.value.map((x) => x.created)).toEqual([false, false, true, false, true])
      expect(r.value[0].contact?.name).toBe('Existing')
      expect(r.value[1].contact).toBeNull()
      expect(r.value[2].contact?.name).toBeNull()
      const events = await h.events()
      expect(events).toHaveLength(4)
      for (const x of r.value.filter((x) => x.created)) {
        expect(events.find((e) => e.resource_id === x.identity.id)?.after).toEqual(x.identity)
        expect(events.find((e) => e.resource_id === x.contact!.id)?.after).toEqual(x.contact)
      }
    } finally {
      await h.close()
    }
  })
}
