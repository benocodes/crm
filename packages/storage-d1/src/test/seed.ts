// Test-only seeds for one D1 deployment: the marker, the local organisation and fixed principals.
import { uuidv7 } from '@vault/storage'
import type { D1Like } from '../binding.js'

export const SEED_AT = '2026-10-22T08:00:00.000Z'

export async function seedDeployment(
  d1: D1Like,
  opts: { organizationId: string; name?: string; provider?: string; externalId?: string },
): Promise<void> {
  await d1.batch([
    d1
      .prepare('INSERT INTO deployment (singleton, organization_id, auth_provider, auth_org_id) VALUES (1, ?, ?, ?)')
      .bind(opts.organizationId, opts.provider ?? 'clerk', opts.externalId ?? `org_${opts.organizationId.slice(-6)}`),
    d1
      .prepare('INSERT INTO organizations (id, created_at, updated_at, name) VALUES (?, ?, ?, ?)')
      .bind(opts.organizationId, SEED_AT, SEED_AT, opts.name ?? 'Local organisation'),
  ])
}

export async function seedPrincipal(
  d1: D1Like,
  opts: { id: string; kind: 'user' | 'agent' | 'system'; email?: string },
): Promise<void> {
  const statements = [d1.prepare('INSERT INTO principals (id, kind, created_at) VALUES (?, ?, ?)').bind(opts.id, opts.kind, SEED_AT)]
  if (opts.kind === 'user') {
    statements.push(
      d1
        .prepare('INSERT INTO users (id, created_at, updated_at, email) VALUES (?, ?, ?, ?)')
        .bind(opts.id, SEED_AT, SEED_AT, opts.email ?? `${opts.id.slice(-12)}@seed.test`),
    )
  }
  await d1.batch(statements)
}

/** A membership row (the directory sync writes these on Postgres; a D1 deployment seeds them). `at` stamps the row. */
export async function seedMembership(
  d1: D1Like,
  opts: { id?: string; organizationId: string; userId: string; role: 'owner' | 'member'; createdBy?: string; at?: string },
): Promise<string> {
  const id = opts.id ?? uuidv7()
  const at = opts.at ?? SEED_AT
  await d1
    .prepare('INSERT INTO memberships (id, created_at, updated_at, organization_id, user_id, role, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, at, at, opts.organizationId, opts.userId, opts.role, opts.createdBy ?? opts.userId)
    .run()
  return id
}

/** An agent: its principal and its agents row. `scopes` are stored as the JSON array the column holds. */
export async function seedAgent(
  d1: D1Like,
  opts: { id: string; organizationId: string; createdBy: string; name?: string; scopes?: readonly string[]; at?: string },
): Promise<void> {
  const at = opts.at ?? SEED_AT
  await d1.batch([
    d1.prepare('INSERT INTO principals (id, kind, created_at) VALUES (?, ?, ?)').bind(opts.id, 'agent', at),
    d1
      .prepare('INSERT INTO agents (id, created_at, updated_at, organization_id, name, scopes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(opts.id, at, at, opts.organizationId, opts.name ?? 'seeded-agent', JSON.stringify(opts.scopes ?? []), opts.createdBy),
  ])
}
