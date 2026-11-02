import { codecs, defineOperation, execute, readMaybe, step, unit, uuidv7, type PreparedOperation, type Read, type Step, type StorageBinding } from '@vault/storage'
import { generateApiKey } from './auth/api-keys.js'
import { assertAgentGrantable, grantableScopes } from './auth/roles.js'
import { SYSTEM_PRINCIPAL_READ, systemPrincipalRead, systemPrincipalSteps } from './directory/system-principal.js'
import { createVaultRegistry } from './operations.js'
import { ScopeSet } from './scopes.js'

export type WorkspaceBootstrapResult = { organizationId: string; agentId: string | null; apiKeyId: string | null; key: string | null }
export type WorkspaceBootstrapArgs = {
  /** The deployment's organisation id: the D1 binding's. */
  organizationId: string
  organizationName: string
  link: { provider: string; externalId: string }
  /** The operator agent and its key, or null for none. */
  agent: { name: string; scopes: readonly string[]; ids: { agent: string; apiKey: string }; secret: { hash: string; prefix: string; key: string } } | null
  /** Mints the system principal when it does not exist yet. */
  systemId: string
  now: Date
}

const ORG = 'bsw:org'

/**
 * Bootstrap of a Clerk-backed single-workspace deployment ([[CORE64]] D11): ONE internal unit that creates NO human. The
 * organisation row, and optionally the operator agent and its API key, all attributed to the `system` principal (created here
 * when absent, [[CORE3]] D22). No events: the same named exception as `bootstrapOperation` ([[CORE15]]). The first owner is the person
 * whose Clerk invitation carries `vibase_role: owner`, and they arrive through first sight.
 */
export function bootstrapWorkspaceOperation(a: WorkspaceBootstrapArgs): PreparedOperation<WorkspaceBootstrapResult> {
  const at = codecs.timestamp.write(a.now)
  return defineOperation<WorkspaceBootstrapResult>({
    name: 'ops.bootstrap_workspace',
    mutates: true,
    reads: (qc) => {
      const reads: Record<string, Read> = {
        [ORG]: readMaybe(qc.db.selectFrom('organizations').select('organizations.id').where('organizations.id', '=', a.organizationId)),
        [SYSTEM_PRINCIPAL_READ]: systemPrincipalRead(qc),
      }
      return reads
    },
    build: (found, qc) => {
      if (found.maybe(ORG)) throw new Error(`organization ${a.organizationId} is already initialised`)
      const sys = systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), a.systemId, at)
      const steps: Step[] = [
        ...sys.steps,
        step(qc.db.insertInto('organizations').values({ id: a.organizationId, created_at: at, updated_at: at, name: a.organizationName, auth_provider: a.link.provider, auth_org_id: a.link.externalId })),
      ]
      if (a.agent) {
        steps.push(
          step(qc.db.insertInto('principals').values({ id: a.agent.ids.agent, kind: 'agent', created_at: at })),
          step(
            qc.db.insertInto('agents').values({ id: a.agent.ids.agent, created_at: at, updated_at: at, organization_id: a.organizationId, name: a.agent.name, scopes: [...a.agent.scopes], created_by: sys.id }),
          ),
          step(
            qc.db.insertInto('api_keys').values({
              id: a.agent.ids.apiKey,
              created_at: at,
              updated_at: at,
              organization_id: a.organizationId,
              agent_id: a.agent.ids.agent,
              key_hash: a.agent.secret.hash,
              prefix: a.agent.secret.prefix,
              last_used_at: null,
              revoked_at: null,
              expires_at: null,
              created_by: sys.id,
            }),
          ),
        )
      }
      const labelled = steps.map((s, i) => (i === 0 ? { ...s, label: 'first-mutation' as const } : s))
      return unit({
        steps: labelled,
        events: [],
        decode: () => ({ organizationId: a.organizationId, agentId: a.agent?.ids.agent ?? null, apiKeyId: a.agent?.ids.apiKey ?? null, key: a.agent?.secret.key ?? null }),
      })
    },
  })
}

/**
 * Creates the organisation and, when `agentName` is given, the operator agent and key of a single-workspace deployment. A
 * development and ops tool; validation and the key's creation happen before the unit, and the plaintext key is in the result only.
 */
export async function bootstrapWorkspace(
  storage: StorageBinding,
  opts: { organizationName: string; agentName?: string; scopes?: readonly string[] },
  env: { now?: Date; newId?: () => string; randomBytes?: (n: number) => Uint8Array } = {},
): Promise<WorkspaceBootstrapResult> {
  if (storage.kind !== 'd1') throw new Error('a workspace bootstrap serves a D1 deployment only')
  const declared = createVaultRegistry().declaredScopes()
  const scopes = opts.scopes ? ScopeSet.parse(opts.scopes).toStrings() : grantableScopes(declared)
  for (const s of scopes) if (!declared.includes(s)) throw new Error(`unknown scope: ${s}`)
  assertAgentGrantable(scopes, declared)
  const now = env.now ?? new Date()
  const newId = env.newId ?? (() => uuidv7(now))
  const secret = opts.agentName === undefined ? null : await generateApiKey(env.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))
  const op = bootstrapWorkspaceOperation({
    organizationId: storage.organizationId,
    organizationName: opts.organizationName,
    link: { provider: storage.authProvider, externalId: storage.authOrgId },
    agent: opts.agentName === undefined || secret === null ? null : { name: opts.agentName, scopes, ids: { agent: newId(), apiKey: newId() }, secret },
    systemId: newId(),
    now,
  })
  return (await execute(storage, { kind: 'internal', organizationId: null }, op)).value
}
