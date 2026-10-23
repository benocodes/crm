// Test-only. The D1 golden backend: one local Miniflare D1, the same fixed principals as the Postgres backend,
// the real app and prepared executor, the clock and ids injected. Replays the committed fixtures.
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { coldDb } from '@vault/storage'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vault/storage-d1/test'
import { seedDeployment, seedPrincipal } from '@vault/storage-d1/test/seed'
import { createApp } from '../../rest/app.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../user-auth.js'
import { goldenId } from './pg-backend.js'
import type { EventView, GoldenBackend } from './runner.js'
import { IDS, type GoldenActor } from './scenarios.js'

export interface D1GoldenBackend extends GoldenBackend {
  close(): Promise<void>
}

export async function d1GoldenBackend(): Promise<D1GoldenBackend> {
  const local: LocalD1 = await openLocalD1(['GOLDEN'])
  const d1: D1Like = local.bindings.GOLDEN!
  let now = new Date(0)
  let counter = 0
  const unusedDb = coldDb('d1') as unknown as Kysely<Database>
  const binding = d1Binding(d1, { organizationId: IDS.org })
  const app = createApp({
    db: () => unusedDb,
    userAuthenticator: fakeUserAuthenticator(),
    storage: () => binding,
    clock: () => now,
    newId: () => goldenId(++counter),
  })
  const scopes = ['tasks:read', 'tasks:write']
  return {
    async reset() {
      await clearD1(d1)
      counter = 0
      await seedDeployment(d1, { organizationId: IDS.org })
      await seedPrincipal(d1, { id: IDS.user, kind: 'user', email: `${IDS.user.slice(-4)}@golden.test` })
      await seedPrincipal(d1, { id: IDS.user2, kind: 'user', email: `${IDS.user2.slice(-4)}@golden.test` })
      await seedPrincipal(d1, { id: IDS.agent, kind: 'agent' })
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
