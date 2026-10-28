import { sql, type SqlBool } from 'kysely'
import { assertStep, defineOperation, readMaybe, step, unit, type PreparedOperation } from '@vault/storage'
import type { D1Like } from '@vault/storage-d1'

/** The deployment marker ([[CORE35]] D18, D1 migration 0001): the one organisation this database serves and its auth link. */
export type DeploymentLink = { organizationId: string; authProvider: string; authOrgId: string }

const conflict = (existing: DeploymentLink) =>
  new Error(`deployment is already initialised for organization ${existing.organizationId} (${existing.authProvider}:${existing.authOrgId})`)

const toLink = (row: Record<string, unknown>): DeploymentLink => ({
  organizationId: row.organization_id as string,
  authProvider: row.auth_provider as string,
  authOrgId: row.auth_org_id as string,
})

/**
 * Reads the marker with one raw statement. Composition code only: `deployment` is machinery, not a modelled resource, so
 * no prepared operation selects it for the app (the Worker, the CLI and `initDeploymentOperation`'s own plan read use this shape).
 */
export async function readDeployment(d1: D1Like): Promise<DeploymentLink | null> {
  const row = await d1.prepare('select organization_id, auth_provider, auth_org_id from deployment where singleton = 1').first()
  return row ? toLink(row) : null
}

/**
 * Creates the deployment marker as one internal unit ([[CORE38]] D6, P6): equal marker is `'existing'` with no statement; a
 * different one is refused before any statement; an absent one is inserted with ON CONFLICT DO NOTHING and an assertion that the
 * row now holds exactly these values, so a racing initialiser with other values drifts instead of silently winning.
 * Not a resource: no event (invariant 5, machinery tables).
 */
export function initDeploymentOperation(link: DeploymentLink): PreparedOperation<'created' | 'existing'> {
  return defineOperation<'created' | 'existing'>({
    name: 'ops.init_deployment',
    mutates: true,
    reads: (qc) => ({
      marker: readMaybe(sql`select organization_id, auth_provider, auth_org_id from deployment where singleton = 1`.compile(qc.db)),
    }),
    build: (found, qc) => {
      const row = found.maybe('marker')
      if (row) {
        const existing = toLink(row)
        if (existing.organizationId !== link.organizationId || existing.authProvider !== link.authProvider || existing.authOrgId !== link.authOrgId) throw conflict(existing)
        return unit({ steps: [], events: [], decode: () => 'existing' as const })
      }
      const insert = sql`insert into deployment (singleton, organization_id, auth_provider, auth_org_id) values (1, ${link.organizationId}, ${link.authProvider}, ${link.authOrgId}) on conflict do nothing`.compile(qc.db)
      const holds = sql<SqlBool>`exists (select 1 from deployment where singleton = 1 and organization_id = ${link.organizationId} and auth_provider = ${link.authProvider} and auth_org_id = ${link.authOrgId})`
      return unit({ steps: [step(insert, 'first-mutation'), assertStep(qc, holds)], events: [], decode: () => 'created' as const })
    },
  })
}
