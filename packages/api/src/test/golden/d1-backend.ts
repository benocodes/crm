// Test-only. The D1 golden backend: one local Miniflare D1, the same fixed principals as the Postgres backend,
// the real app and the prepared path, the clock and ids injected. Replays the committed fixtures.
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vault/storage-d1/test'
import { seedAgent, seedDeployment, seedMembership, seedPrincipal } from '@vault/storage-d1/test/seed'
import { memoryObjectStore, type ObjectStore } from '../../objects/store.js'
import { createApp } from '../../rest/app.js'
import { hashApiKey } from '../../auth/api-keys.js'
import { goldenAuthenticator, goldenClerk, goldenSend, loadGoldenClerk, mountGoldenWebhook } from './kit.js'
import { GOLDEN_SCOPES, GOLDEN_SEED_AT, goldenId, goldenRandomBytes } from './pg-backend.js'
import { MESSAGING_SCOPES, seedMessaging } from './messaging-seed.js'
import type { EventView, GoldenBackend } from './runner.js'
import { GOLDEN_AGENT_KEY, GOLDEN_EXPIRED_KEY, GOLDEN_ORG_LINK, GOLDEN_SUBJECTS, IDS, type GoldenActor } from './scenarios.js'

/**
 * An event payload with its keys in Postgres `jsonb` order (shorter key first, then bytewise), recursively. D1 stores the payload as
 * text in insertion order and Postgres canonicalises it, so the committed fixtures (recorded on Postgres) carry that order. Sorting
 * here keeps the file text independent of how a program happened to build the payload, and the D21 parity diff free of reorderings.
 */
export function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder)
  if (value === null || typeof value !== 'object') return value
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(keys.map((k) => [k, jsonbOrder((value as Record<string, unknown>)[k])]))
}

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
  // The object store scenarios read content from (CORE69 D22): replaced on every reset, reached through a forwarder so the app keeps one.
  let store: ObjectStore = memoryObjectStore()
  const objects: ObjectStore = {
    put: (...a) => store.put(...a),
    putStream: (...a) => store.putStream(...a),
    get: (k) => store.get(k),
    delete: (k) => store.delete(k),
  }
  const app = createApp({
    userAuthenticator: goldenAuthenticator(clerk),
    storage: () => binding,
    clock,
    newId,
    randomBytes: goldenRandomBytes(random),
    objects,
  })
  mountGoldenWebhook(app, clerk, { clock, newId })
  // The seeded agent keeps GOLDEN_SCOPES (the older fixtures list it); a messaging scenario's tokens also carry the messaging reads.
  let scopes: readonly string[] = GOLDEN_SCOPES
  return {
    async reset() {
      await clearD1(d1)
      counter = 0
      random.n = 0
      store = memoryObjectStore()
      scopes = GOLDEN_SCOPES
      await seedDeployment(d1, { organizationId: IDS.org, externalId: GOLDEN_ORG_LINK, name: `Golden ${IDS.org.slice(-4)}` })
      await seedPrincipal(d1, { id: IDS.user, kind: 'user', email: `${IDS.user.slice(-4)}@golden.test`, authSubject: GOLDEN_SUBJECTS.user })
      await seedPrincipal(d1, { id: IDS.user2, kind: 'user', email: `${IDS.user2.slice(-4)}@golden.test`, authSubject: GOLDEN_SUBJECTS.user2 })
      await seedMembership(d1, { id: IDS.membership, organizationId: IDS.org, userId: IDS.user, role: 'owner', at: GOLDEN_SEED_AT })
      await seedMembership(d1, { id: IDS.membership2, organizationId: IDS.org, userId: IDS.user2, role: 'member', at: GOLDEN_SEED_AT })
      await seedAgent(d1, { id: IDS.agent, organizationId: IDS.org, createdBy: IDS.user, name: 'golden-agent', scopes, at: GOLDEN_SEED_AT })
    },
    async load(scenario) {
      loadGoldenClerk(clerk, scenario.clerk)
      if (scenario.seed === 'messaging') {
        scopes = [...GOLDEN_SCOPES, ...MESSAGING_SCOPES]
        now = new Date(GOLDEN_SEED_AT)
        await seedMessaging({ binding, organizationId: IDS.org, actorId: IDS.user, objects: store, clock, newId, randomBytes: goldenRandomBytes(random) })
      }
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
          before: r.before === null ? null : jsonbOrder(JSON.parse(r.before!)),
          after: r.after === null ? null : jsonbOrder(JSON.parse(r.after!)),
        }),
      )
    },
    async rowCounts() {
      const out: Record<string, number> = {}
      for (const t of ['organizations', 'principals', 'users', 'memberships', 'agents', 'api_keys', 'events', 'tasks', 'threads', 'messages', 'message_attachments', 'message_sources', 'thread_sources', 'interactions', 'interaction_participants', 'files', 'contact_files', 'company_files', 'identities']) {
        out[t] = Number((await d1.prepare(`SELECT count(*) AS n FROM "${t}"`).first())!.n)
      }
      return out
    },
    close: () => local.dispose(),
  }
}
