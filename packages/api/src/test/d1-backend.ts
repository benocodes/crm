// Test-only. The D1 backend of the shared contract suite ([[CORE35]] D16/D18): one local Miniflare D1 binding
// PER TENANT (never two tenants in one D1), the real app and the prepared path, the injected-principal
// authentication stand-in. Nothing reaches a remote database.
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { coldDb, uuidv7 } from '@vault/storage'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { clearD1, openLocalD1 } from '@vault/storage-d1/test'
import { seedAgent, seedDeployment, seedMembership, seedPrincipal } from '@vault/storage-d1/test/seed'
import { Registry } from '../registry.js'
import { createApp } from '../rest/app.js'
import type { ContractBackend, ContractSession, ContractTenant, EventRow } from './contract.js'
import { d1Value, withTenantDefaults } from './insert.js'
import { coldStorage } from './storage.js'
import { fakeUserAuthenticator, mintTestUserToken } from './user-auth.js'

/** The contract suite's D1 tenants share one provider link (a link is unique per database, and each tenant has its own D1). */
const CONTRACT_ORG_LINK = 'org_contract'
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)

export function d1Backend(): ContractBackend {
  return {
    name: 'd1',
    async open(registry: Registry): Promise<ContractSession> {
      const local = await openLocalD1(['A', 'B'])
      const names = ['A', 'B'] as const
      const byOrg = new Map<string, { d1: D1Like; app: ReturnType<typeof createApp> }>()
      // The relational Kysely of a ContractSession is Postgres-only; a cold one stands in on D1 (it cannot execute).
      const unusedDb = coldDb('d1') as unknown as Kysely<Database>
      const all = () => [...byOrg.values()]
      return {
        // Routes without a credential or a database: the document and the 401 cases.
        app: createApp({ storage: coldStorage(), registry, userAuthenticator: fakeUserAuthenticator() }),
        db: unusedDb,
        owner: unusedDb,
        async reset() {
          byOrg.clear()
          const tenants: ContractTenant[] = []
          for (const name of names) {
            const d1 = local.bindings[name]!
            await clearD1(d1)
            const t: ContractTenant = { organizationId: uuidv7(), userId: uuidv7(), agentId: uuidv7() }
            await seedDeployment(d1, { organizationId: t.organizationId, externalId: CONTRACT_ORG_LINK })
            await seedPrincipal(d1, { id: t.userId, kind: 'user' })
            await seedMembership(d1, { organizationId: t.organizationId, userId: t.userId, role: 'owner' })
            await seedAgent(d1, { id: t.agentId, organizationId: t.organizationId, createdBy: t.userId })
            const binding = d1Binding(d1, { organizationId: t.organizationId, authProvider: 'clerk', authOrgId: CONTRACT_ORG_LINK })
            const app = createApp({ registry, userAuthenticator: fakeUserAuthenticator(), storage: () => binding })
            byOrg.set(t.organizationId, { d1, app })
            tenants.push(t)
          }
          return { a: tenants[0]!, b: tenants[1]! }
        },
        close: () => local.dispose(),
        async call(t, actor, scopes, method, path, body) {
          const token = mintTestUserToken({
            userId: actor === 'agent' ? t.agentId : t.userId,
            organizationId: t.organizationId,
            scopes,
            kind: actor,
          })
          return byOrg.get(t.organizationId)!.app.request(path, {
            method,
            headers: { authorization: `Bearer ${token}` },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        },
        async principalId(t, actor) {
          return actor === 'agent' ? t.agentId : t.userId
        },
        async seedMember(t, role) {
          const d1 = byOrg.get(t.organizationId)!.d1
          const userId = uuidv7()
          await seedPrincipal(d1, { id: userId, kind: 'user' })
          return { userId, membershipId: await seedMembership(d1, { organizationId: t.organizationId, userId, role }) }
        },
        async insert(t, table, row) {
          const d1 = byOrg.get(t.organizationId)!.d1
          const full = withTenantDefaults(table, row, t)
          const cols = Object.keys(full)
          await d1.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => d1Value(full[c]))).run()
          return full as Record<string, any>
        },
        async eventsOf(id): Promise<EventRow[]> {
          const rows: EventRow[] = []
          for (const { d1 } of all()) {
            const r = await d1.prepare('SELECT * FROM events WHERE resource_id = ? ORDER BY id').bind(id).all()
            rows.push(...(r.results as EventRow[]).map((e) => ({ ...e, before: parse(e.before), after: parse(e.after) })))
          }
          return rows
        },
        async countEvents() {
          let n = 0
          for (const { d1 } of all()) n += Number((await d1.prepare('SELECT count(*) AS n FROM events').first())!.n)
          return n
        },
        async countRows(table) {
          let n = 0
          for (const { d1 } of all()) n += Number((await d1.prepare(`SELECT count(*) AS n FROM "${table}"`).first())!.n)
          return n
        },
      }
    },
  }
}
