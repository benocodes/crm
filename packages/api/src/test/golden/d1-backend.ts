// Test-only. The D1 golden backend: one local Miniflare D1, the same fixed principals as the Postgres backend,
// the real app and prepared executor, the clock and ids injected. Replays the committed fixtures.
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { coldDb } from '@vault/storage'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vault/storage-d1/test'
import { seedAgent, seedDeployment, seedMembership, seedPrincipal } from '@vault/storage-d1/test/seed'
import { createApp } from '../../rest/app.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../user-auth.js'
import { GOLDEN_SCOPES, GOLDEN_SEED_AT, goldenId, goldenRandomBytes } from './pg-backend.js'
import type { EventView, GoldenBackend } from './runner.js'
import { GOLDEN_ORG_LINK, IDS, type GoldenActor } from './scenarios.js'

export interface D1GoldenBackend extends GoldenBackend {
  close(): Promise<void>
}

export async function d1GoldenBackend(): Promise<D1GoldenBackend> {
  const local: LocalD1 = await openLocalD1(['GOLDEN'])
  const d1: D1Like = local.bindings.GOLDEN!
  let now = new Date(0)
  let counter = 0
  const random = { n: 0 }
  const unusedDb = coldDb('d1') as unknown as Kysely<Database>
  const binding = d1Binding(d1, { organizationId: IDS.org, authProvider: 'clerk', authOrgId: GOLDEN_ORG_LINK })
  const app = createApp({
    db: () => unusedDb,
    userAuthenticator: fakeUserAuthenticator(),
    storage: () => binding,
    clock: () => now,
    newId: () => goldenId(++counter),
    randomBytes: goldenRandomBytes(random),
  })
  const scopes = GOLDEN_SCOPES
  return {
    async reset() {
      await clearD1(d1)
      counter = 0
      random.n = 0
      await seedDeployment(d1, { organizationId: IDS.org, externalId: GOLDEN_ORG_LINK })
      await seedPrincipal(d1, { id: IDS.user, kind: 'user', email: `${IDS.user.slice(-4)}@golden.test` })
      await seedPrincipal(d1, { id: IDS.user2, kind: 'user', email: `${IDS.user2.slice(-4)}@golden.test` })
      await seedMembership(d1, { id: IDS.membership, organizationId: IDS.org, userId: IDS.user, role: 'owner', at: GOLDEN_SEED_AT })
      await seedMembership(d1, { id: IDS.membership2, organizationId: IDS.org, userId: IDS.user2, role: 'member', at: GOLDEN_SEED_AT })
      await seedAgent(d1, { id: IDS.agent, organizationId: IDS.org, createdBy: IDS.user, name: 'golden-agent', scopes, at: GOLDEN_SEED_AT })
    },
    async send(actor: GoldenActor, method, path, body, clock) {
      now = new Date(clock)
      const token = mintTestUserToken({ userId: actor === 'agent' ? IDS.agent : IDS.user, organizationId: IDS.org, scopes, kind: actor })
      const res = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}` },
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, body: text === '' ? null : JSON.parse(text) }
    },
    async events() {
      const rows = (await d1.prepare('SELECT * FROM events ORDER BY rowid').all()).results as Array<Record<string, string | null>>
      return rows.map(
        (r): EventView => ({
          type: r.type!,
          resource_type: r.resource_type!,
          resource_id: r.resource_id!,
          actor_id: r.actor_id!,
          organization_id: r.organization_id!,
          created_at: r.created_at!,
          before: r.before === null ? null : JSON.parse(r.before!),
          after: r.after === null ? null : JSON.parse(r.after!),
        }),
      )
    },
    close: () => local.dispose(),
  }
}
