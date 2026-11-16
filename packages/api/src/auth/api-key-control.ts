import {
  codecs,
  defineOperation,
  execute,
  readMaybe,
  unit,
  type PreparedOperation,
  type StorageBinding,
} from '@vibase/storage'
import type { ApiKeyStorePort } from '../admin/api-key-port.js'
import { ScopeSet } from '../scopes.js'
import type { InternalEnv } from '../storage/internal.js'
import { authenticateApiKey, hashApiKey, LAST_USED_THROTTLE_MS } from './api-keys.js'
import type { Principal } from './types.js'

// API-key authentication against the control plane's `api_keys` first ([[CORE350]], [[CORE259]] D5, D11 read half). The port is the only way this package reaches control keys: the Worker composition builds it over
// the control store and hands it in, as the audit and webhook ports. Without a port (the parked Postgres composition) keys are CRM keys, exactly as `authenticateApiKey`.

export interface ApiKeyState {
  lastUsedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
}
/** The immutable mapping of a key (id, agent, organisation) and its mutable fields as read. */
export interface ApiKeyLookup extends ApiKeyState {
  id: string
  agentId: string
  organizationId: string
}
export interface ApiKeyControlPort {
  /** The key behind a hash; `null` when control has none. */
  findByHash(keyHash: string): Promise<ApiKeyLookup | null>
  /** The mutable fields of a key by id; `null` when the row is gone. */
  readState(id: string): Promise<ApiKeyState | null>
  /** Stamps `last_used_at` (no audit row, nothing else); `true` when it wrote. */
  stampUsed(a: { id: string; now: string }): Promise<boolean>
}
export interface ApiKeyControlRuntime {
  port: ApiKeyControlPort
  /** [[CORE351]] P5: the store of the four `api_keys.*` operations; absent: they answer `501 provider_not_configured`. Composition sets both from one control store. */
  store?: ApiKeyStorePort | null
}
export type ApiKeyAuthenticator = (storage: StorageBinding, key: string, env: InternalEnv) => Promise<Principal | null>

/** Most key mappings one isolate remembers; the least recently used goes first. A mapping is a few strings, so 1000 is about 150 KB at most. */
export const API_KEY_CACHE_MAX_ENTRIES = 1000

const AGENT = 'auth:agent'
interface AgentRow {
  organizationId: string
  scopes: string[]
  disabled: boolean
}

/** One read-only internal unit: the agent a control key names, by id (keys in control have no foreign key to the CRM's agents, [[CORE259]] D8). */
export function apiKeyAgentOperation(agentId: string): PreparedOperation<AgentRow | null> {
  return defineOperation<AgentRow | null>({
    name: 'auth.api_key_agent',
    mutates: false,
    reads: (qc) => ({
      [AGENT]: readMaybe(
        qc.db
          .selectFrom('agents')
          .select(['agents.organization_id', 'agents.scopes', 'agents.disabled_at'])
          .where('agents.id', '=', agentId),
      ),
    }),
    build: (found) => {
      const row = found.maybe(AGENT)
      const agent: AgentRow | null = row
        ? {
            organizationId: row.organization_id as string,
            scopes: codecs.stringArray.read(row.scopes),
            disabled: codecs.timestamp.readNullable(row.disabled_at) !== null,
          }
        : null
      return unit({ steps: [], events: [], decode: () => agent })
    },
  })
}

/**
 * The authenticator of one composed app ([[CORE350]] P1 to P4). The cache is per authenticator (one per isolate in production): key hash to the immutable `(key id, agent id, organisation id)` only. Revocation, expiry,
 * `last_used_at`, the agent's `disabled_at` and scopes are read on every request; a miss and a CRM-fallback result are never cached.
 */
export function createApiKeyAuthenticator(opts: {
  port: ApiKeyControlPort | null
  maxEntries?: number
}): ApiKeyAuthenticator {
  const { port } = opts
  if (!port) return (storage, key, env) => authenticateApiKey(storage, key, env)
  const max = opts.maxEntries ?? API_KEY_CACHE_MAX_ENTRIES
  const cache = new Map<string, { id: string; agentId: string; organizationId: string }>()
  const remember = (hash: string, m: { id: string; agentId: string; organizationId: string }) => {
    cache.delete(hash)
    cache.set(hash, m)
    while (cache.size > max) cache.delete(cache.keys().next().value as string)
  }

  const readAgent = async (storage: StorageBinding, agentId: string) =>
    (await execute(storage, { kind: 'internal', organizationId: null }, apiKeyAgentOperation(agentId))).value

  /** P1 (a): the rules over a control key's state and its agent. A valid key last used a minute ago or never is stamped in control. */
  async function judge(
    m: { id: string; agentId: string; organizationId: string },
    state: ApiKeyState,
    agent: AgentRow | null,
    now: Date,
  ): Promise<Principal | null> {
    if (state.revokedAt !== null) return null
    if (state.expiresAt !== null && Date.parse(state.expiresAt) <= now.getTime()) return null
    if (!agent || agent.disabled || agent.organizationId !== m.organizationId) return null
    const cutoff = now.getTime() - LAST_USED_THROTTLE_MS
    if (state.lastUsedAt === null || Date.parse(state.lastUsedAt) < cutoff)
      await port!.stampUsed({ id: m.id, now: now.toISOString() })
    return {
      actor: { id: m.agentId, kind: 'agent' },
      organizationId: m.organizationId,
      scopes: ScopeSet.parse(agent.scopes),
    }
  }

  return async (storage, key, env) => {
    const hash = await hashApiKey(key)
    const cached = cache.get(hash)
    if (cached) {
      // P3: no hash lookup; the state and the agent are read together. A vanished state row evicts the entry and the cold path answers.
      const [state, agent] = await Promise.all([port.readState(cached.id), readAgent(storage, cached.agentId)])
      if (state) {
        remember(hash, cached)
        return judge(cached, state, agent, env.now)
      }
      cache.delete(hash)
    }
    const found = await port.findByHash(hash)
    if (!found) return authenticateApiKey(storage, key, env)
    const m = { id: found.id, agentId: found.agentId, organizationId: found.organizationId }
    remember(hash, m)
    return judge(m, found, await readAgent(storage, m.agentId), env.now)
  }
}
