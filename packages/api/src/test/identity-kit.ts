// Test-only. Drives the prepared identity-model operations on either engine with a ticking injected clock,
// and reads back what the program wrote (raw rows, events in write order). Used by the both-engine suites.
import { expect } from 'vitest'
import { type PreparedOperation } from '@vault/storage'
import { ApiError, mapStorageError } from '../errors.js'
import { companies } from '../resources/companies.js'
import { contacts } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { createOperation, getOperation, listOperation, updateOperation } from '../storage/crud.js'
import type { PreparedEnv, PreparedResource } from '../storage/definition.js'
import { deleteCompanyOperation, deleteContactOperation } from '../identity/cascades.js'
import type { Engine, RawRow } from './engines.js'

export const BASE = Date.parse('2026-10-22T10:00:00.000Z')
export type As = { as?: 'agent'; now?: Date }

const IDENTITY_EVENTS = ['company.', 'contact.', 'identity.']

export function identityKit(e: Engine) {
  let tick = 0
  const env = (opts: As = {}): PreparedEnv => e.env({ now: opts.now ?? new Date(BASE + ++tick * 1000), ...(opts.as ? { as: opts.as } : {}) })
  /** Runs an operation built from a fresh environment and returns its value. */
  const run = async <T>(make: (env: PreparedEnv) => PreparedOperation<T>, opts: As = {}): Promise<T> => (await e.run(make(env(opts)), opts.as)).value
  /** The public error a caller would see for a failing call (storage failures mapped like the REST adapter does). */
  const fail = async (make: (env: PreparedEnv) => PreparedOperation<unknown>, opts: As = {}): Promise<ApiError> => {
    const err = await (async () => run(make, opts))().then(() => undefined, (x: unknown) => x)
    expect(err, 'expected the call to fail').toBeDefined()
    const mapped = mapStorageError(err)
    expect(mapped).toBeInstanceOf(ApiError)
    return mapped as ApiError
  }
  const shape = (x: ApiError) => [x.status, x.code, x.message] as const

  type Record_ = Record<string, any>
  const create = (def: PreparedResource<any, any>) => (input: Record<string, unknown>, opts?: As): Promise<Record_> => run((env) => createOperation(def, env, input), opts)
  const update = (def: PreparedResource<any, any>) => (id: string, input: Record<string, unknown>, opts?: As): Promise<Record_> =>
    run((env) => updateOperation(def, env, id, input), opts)

  return {
    env,
    run,
    fail,
    shape,
    company: create(companies),
    contact: create(contacts),
    identity: create(identities),
    updateCompany: update(companies),
    updateContact: update(contacts),
    updateIdentity: update(identities),
    deleteCompany: (id: string, opts?: As) => run((env) => deleteCompanyOperation(env, id), opts),
    deleteContact: (id: string, opts?: As) => run((env) => deleteContactOperation(env, id), opts),
    get: (def: PreparedResource<any, any>, id: string): Promise<Record_> => run((env) => getOperation(def, env, id)),
    list: (def: PreparedResource<any, any>, filters: Record<string, string> = {}): Promise<{ data: Record_[]; next_cursor: string | null }> =>
      run((env) => listOperation(def, env, { filters })),
    /** Identity-model events in write order. */
    async events(): Promise<RawRow[]> {
      return (await e.rows('events')).filter((r) => IDENTITY_EVENTS.some((p) => String(r.type).startsWith(p)))
    },
    async count(table: 'companies' | 'contacts' | 'identities'): Promise<number> {
      return (await e.rows(table)).length
    },
    async row(table: 'companies' | 'contacts' | 'identities', id: string): Promise<RawRow> {
      const r = (await e.rows(table)).find((x) => x.id === id)
      expect(r, `${table} row ${id}`).toBeDefined()
      return r!
    },
  }
}
export type IdentityKit = ReturnType<typeof identityKit>

/** Postgres only: a second real organisation with its own user, to prove cross-tenant refusals. */
export async function foreignTenant(e: Engine) {
  const { seedOrganization, seedUser } = await import('@vault/db/test')
  const { execute } = await import('@vault/storage')
  if (!e.app) throw new Error('a foreign organisation exists on Postgres only (a D1 database holds one organisation)')
  const org = await seedOrganization(e.app, { name: 'Foreign org' })
  const user = await seedUser(e.app, { organizationId: org.id, role: 'owner' })
  let tick = 0
  return {
    organizationId: org.id,
    userId: user.id,
    env: (): PreparedEnv => ({ ...e.env({ now: new Date(BASE + ++tick * 1000) }), organizationId: org.id, actor: { id: user.id, kind: 'user' } }),
    run: <T>(op: PreparedOperation<T>) => execute(e.binding, { kind: 'tenant', actorId: user.id, organizationId: org.id }, op).then((r) => r.value),
  }
}
