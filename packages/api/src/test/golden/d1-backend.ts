// Test-only. The D1 golden backend: one local Miniflare D1, the same fixed principals as the Postgres backend,
// the real app and the prepared path, the clock and ids injected. Replays the committed fixtures.
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vault/storage-d1/test'
import { seedAgent, seedDeployment, seedMembership, seedPrincipal } from '@vault/storage-d1/test/seed'
import { createApp } from '../../rest/app.js'
import { hashApiKey } from '../../auth/api-keys.js'
import { goldenAuthenticator, goldenClerk, goldenSend, loadGoldenClerk, mountGoldenWebhook } from './kit.js'
import { GOLDEN_SCOPES, GOLDEN_SEED_AT, goldenId, goldenRandomBytes } from './pg-backend.js'
import type { EventView, GoldenBackend } from './runner.js'
import { GOLDEN_AGENT_KEY, GOLDEN_EXPIRED_KEY, GOLDEN_ORG_LINK, GOLDEN_SUBJECTS, IDS, type GoldenActor } from './scenarios.js'

export interface D1GoldenBackend extends GoldenBackend {
  close(): Promise<void>
  /** The row count of every modelled table (a refused scenario must leave them as seeded). */
  rowCounts(): Promise<Record<string, number>>
}

export async function d1GoldenBackend(): Promise<D1GoldenBackend> {
  const local: LocalD1 = await openLocalD1(['GOLDEN'])
  const d1: D1Like = local.bindings.GOLDEN!
  let now = new Date(0)
  let counter = 0
  const random = { n: 0 }
  const binding = d1Binding(d1, { organizationId: IDS.org, authProvider: 'clerk', authOrgId: GOLDEN_ORG_LINK })
  const clock = () => now
  const newId = () => goldenId(++counter)
  const clerk = await goldenClerk(clock)
  const app = createApp({
    userAuthenticator: goldenAuthenticator(clerk),
    storage: () => binding,
    clock,
    newId,
    randomBytes: goldenRandomBytes(random),
  })
  mountGoldenWebhook(app, clerk, { clock, newId })
  const scopes = GOLDEN_SCOPES
  return {
    async reset() {
      await clearD1(d1)
      counter = 0
      random.n = 0
      await seedDeployment(d1, { organizationId: IDS.org, externalId: GOLDEN_ORG_LINK, name: `Golden ${IDS.org.slice(-4)}` })
      await seedPrincipal(d1, { id: IDS.user, kind: 'user', email: `${IDS.user.slice(-4)}@golden.test`, authSubject: GOLDEN_SUBJECTS.user })
      await seedPrincipal(d1, { id: IDS.user2, kind: 'user', email: `${IDS.user2.slice(-4)}@golden.test`, authSubject: GOLDEN_SUBJECTS.user2 })
      await seedMembership(d1, { id: IDS.membership, organizationId: IDS.org, userId: IDS.user, role: 'owner', at: GOLDEN_SEED_AT })
      await seedMembership(d1, { id: IDS.membership2, organizationId: IDS.org, userId: IDS.user2, role: 'member', at: GOLDEN_SEED_AT })
      await seedAgent(d1, { id: IDS.agent, organizationId: IDS.org, createdBy: IDS.user, name: 'golden-agent', scopes, at: GOLDEN_SEED_AT })
    },
    async load(scenario) {
      loadGoldenClerk(clerk, scenario.clerk)
      if (!scenario.keys) return
      // The agent's two fixed keys (CORE41 P15): one valid, one that expired half an hour after the seed instant.
      for (const [id, key, expires] of [[IDS.agentKey, GOLDEN_AGENT_KEY, null], [IDS.expiredKey, GOLDEN_EXPIRED_KEY, '2026-10-22T08:30:00.000Z']] as const) {
        await d1
          .prepare('INSERT INTO api_keys (id, created_at, updated_at, organization_id, agent_id, key_hash, prefix, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, GOLDEN_SEED_AT, GOLDEN_SEED_AT, IDS.org, IDS.agent, await hashApiKey(key), 'vk_golden-ag', expires, IDS.user)
          .run()
      }
    },
    async send(actor: GoldenActor, method, path, body, at) {
      now = new Date(at)
      return goldenSend({ app, clerk, scopes }, actor, method, path, body, now)
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
    async rowCounts() {
      const out: Record<string, number> = {}
      for (const t of ['organizations', 'principals', 'users', 'memberships', 'agents', 'api_keys', 'events', 'tasks']) {
        out[t] = Number((await d1.prepare(`SELECT count(*) AS n FROM "${t}"`).first())!.n)
      }
      return out
    },
    close: () => local.dispose(),
  }
}
