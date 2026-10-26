import { sql, type SqlBool } from 'kysely'
import { assertStep, codecs, defineOperation, execute, readMaybe, step, ts, unit, uuidv7, type PreparedOperation, type Read, type StorageBinding } from '@vault/storage'
import { generateApiKey } from './auth/api-keys.js'
import { assertAgentGrantable, grantableScopes } from './auth/roles.js'
import { ApiError } from './errors.js'
import { normalizeIdentityValue } from './identity/normalize.js'
import { createVaultRegistry } from './operations.js'
import { ScopeSet } from './scopes.js'

export type BootstrapResult = { organizationId: string; userId: string; agentId: string; apiKeyId: string; key: string }
export type BootstrapArgs = {
  /** The new organisation's id: minted on Postgres, the binding's own on D1. */
  organizationId: string
  organizationName: string
  /** The organisation's provider link: the deployment's on D1, none on Postgres (the directory links it on first sign-in). */
  link: { provider: string; externalId: string } | null
  /** Normalised (D7). */
  email: string
  userName: string | null
  login: { provider: string; subject: string } | null
  agentName: string
  scopes: readonly string[]
  /** Minted ids: the user (used only when the email is new), the owner membership, the agent and the key. */
  ids: { user: string; membership: string; agent: string; apiKey: string }
  /** The made key. Its plaintext appears only in the result, never in a statement. */
  secret: { key: string; hash: string; prefix: string }
  now: Date
}

const USER = 'bs:user'
const HOLDER = 'bs:holder'
const ORG = 'bs:org'

/**
 * Bootstrap as ONE internal unit with no organisation to lock and NO events ([[CORE41]] P14, [[CORE15]]: a named exception to
 * invariant 5; the directory sync is the event-emitting path). Plan reads: the user by email, the holder of the login when one
 * is given, and the organisation row. Refusals keep their plain messages. Statements in order: the organisation, then for a
 * new user the principal, the user ON CONFLICT DO NOTHING and an assertion that the email's user is the minted one (or, for an
 * existing unlinked user, a guarded link update), the owner membership, the agent principal and agent, and the key.
 */
export function bootstrapOperation(a: BootstrapArgs): PreparedOperation<BootstrapResult> {
  const at = codecs.timestamp.write(a.now)
  return defineOperation<BootstrapResult>({
    name: 'ops.bootstrap',
    mutates: true,
    reads: (qc) => {
      const reads: Record<string, Read> = {
        [USER]: readMaybe(
          qc.db
            .selectFrom('users')
            .select(['users.id', 'users.auth_provider', 'users.auth_subject', ts.exact(qc, 'users.updated_at').as('__stamp')])
            .where('users.email', '=', a.email),
        ),
        [ORG]: readMaybe(qc.db.selectFrom('organizations').select('organizations.id').where('organizations.id', '=', a.organizationId)),
      }
      if (a.login) {
        reads[HOLDER] = readMaybe(qc.db.selectFrom('users').select('users.id').where('users.auth_provider', '=', a.login.provider).where('users.auth_subject', '=', a.login.subject))
      }
      return reads
    },
    build: (found, qc) => {
      if (found.maybe(ORG)) throw new Error(`organization ${a.organizationId} is already initialised`)
      const user = found.maybe(USER)
      const login = a.login
      if (login) {
        const holder = found.maybe(HOLDER)
        if (holder && holder.id !== user?.id) throw new Error(`login ${login.provider}:${login.subject} belongs to another user`)
        if (user && user.auth_subject !== null && (user.auth_provider !== login.provider || user.auth_subject !== login.subject)) {
          throw new Error(`user ${a.email} is linked to another login`)
        }
      }
      const userId = (user?.id as string | undefined) ?? a.ids.user

      const steps = [
        step(
          qc.db.insertInto('organizations').values({
            id: a.organizationId,
            created_at: at,
            updated_at: at,
            name: a.organizationName,
            auth_provider: a.link?.provider ?? null,
            auth_org_id: a.link?.externalId ?? null,
          }),
          'first-mutation',
        ),
      ]
      if (!user) {
        steps.push(
          step(qc.db.insertInto('principals').values({ id: a.ids.user, kind: 'user', created_at: at })),
          step(
            qc.db
              .insertInto('users')
              .values({
                id: a.ids.user,
                created_at: at,
                updated_at: at,
                email: a.email,
                name: a.userName,
                auth_provider: login?.provider ?? null,
                auth_subject: login?.subject ?? null,
                email_verified: false,
              })
              .onConflict((oc) => oc.doNothing()),
          ),
          // A user inserted by a racing bootstrap leaves ours a no-op: the assertion aborts the unit whole, so no orphan principal remains.
          assertStep(qc, sql<SqlBool>`exists (select 1 from "users" where "users"."email" = ${a.email} and "users"."id" = ${a.ids.user})`),
        )
      } else if (login && user.auth_subject === null) {
        steps.push(
          step(
            qc.db
              .updateTable('users')
              .set({ auth_provider: login.provider, auth_subject: login.subject, updated_at: at })
              .where('users.id', '=', userId)
              .where('users.auth_subject', 'is', null)
              .where(sql<SqlBool>`${ts.exact(qc, 'users.updated_at')} = ${String(user.__stamp)}`),
            undefined,
            { expect: 'affected' },
          ),
        )
      }
      steps.push(
        step(qc.db.insertInto('memberships').values({ id: a.ids.membership, created_at: at, updated_at: at, organization_id: a.organizationId, user_id: userId, role: 'owner', created_by: userId })),
        step(qc.db.insertInto('principals').values({ id: a.ids.agent, kind: 'agent', created_at: at })),
        step(
          qc.db.insertInto('agents').values({ id: a.ids.agent, created_at: at, updated_at: at, organization_id: a.organizationId, name: a.agentName, scopes: [...a.scopes], created_by: userId }),
        ),
        step(
          qc.db.insertInto('api_keys').values({
            id: a.ids.apiKey,
            created_at: at,
            updated_at: at,
            organization_id: a.organizationId,
            agent_id: a.ids.agent,
            key_hash: a.secret.hash,
            prefix: a.secret.prefix,
            last_used_at: null,
            revoked_at: null,
            expires_at: null,
            created_by: userId,
          }),
        ),
      )
      return unit({
        steps,
        events: [],
        decode: () => ({ organizationId: a.organizationId, userId, agentId: a.ids.agent, apiKeyId: a.ids.apiKey, key: a.secret.key }),
      })
    },
  })
}

/**
 * Mints a first organisation, an owner user (reused if the email exists) and an agent with an API key. A development and
 * ops tool: it emits no events (a named exception to invariant 5; the directory sync ([[CORE3]]) is the event-emitting path
 * for organisations and memberships). With `authSubject` it also links the user's login ([[CORE3]] D5). Validation and the
 * key's creation happen before the unit; the plaintext key is in the result only.
 */
export async function bootstrap(
  storage: StorageBinding,
  opts: {
    organizationName: string
    email: string
    userName?: string
    agentName: string
    scopes?: readonly string[]
    /** Defaults to 'clerk' when `authSubject` is given. */
    authProvider?: string
    authSubject?: string
  },
  env: { now?: Date; newId?: () => string; randomBytes?: (n: number) => Uint8Array } = {},
): Promise<BootstrapResult> {
  const declared = createVaultRegistry().declaredScopes()
  const scopes = opts.scopes ? ScopeSet.parse(opts.scopes).toStrings() : grantableScopes(declared)
  for (const s of scopes) if (!declared.includes(s)) throw new Error(`unknown scope: ${s}`)
  assertAgentGrantable(scopes, declared)
  let email: string
  try {
    email = normalizeIdentityValue('email', opts.email)
  } catch (err) {
    // The CLI wants a plain message (D7).
    if (err instanceof ApiError) throw new Error(err.message)
    throw err
  }
  const now = env.now ?? new Date()
  const newId = env.newId ?? (() => uuidv7(now))
  const secret = await generateApiKey(env.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))
  const login = opts.authSubject !== undefined ? { provider: opts.authProvider ?? 'clerk', subject: opts.authSubject } : null
  const minted = newId() // consumed on both engines: the id source advances the same way
  const op = bootstrapOperation({
    organizationId: storage.kind === 'd1' ? storage.organizationId : minted,
    organizationName: opts.organizationName,
    link: storage.kind === 'd1' ? { provider: storage.authProvider, externalId: storage.authOrgId } : null,
    email,
    userName: opts.userName ?? null,
    login,
    agentName: opts.agentName,
    scopes,
    ids: { user: newId(), membership: newId(), agent: newId(), apiKey: newId() },
    secret,
    now,
  })
  return (await execute(storage, { kind: 'internal', organizationId: null }, op)).value
}
