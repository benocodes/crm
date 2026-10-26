import {
  codecs,
  defineOperation,
  execute,
  readMaybe,
  step,
  unit,
  type PreparedOperation,
  type StorageBinding,
} from '@vault/storage'
import { ScopeSet } from '../scopes.js'
import type { InternalEnv } from '../storage/internal.js'
import type { Principal } from './types.js'

export const API_KEY_PREFIX = 'vk_'

// Web Crypto only (no node:crypto), so the same code runs in workerd.
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

/** SHA-256, lowercase hex. High-entropy keys need no slow hash. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The random source is injected (CORE40 P8) so golden runs can record a key; real code passes `crypto.getRandomValues`. */
export async function generateApiKey(randomBytes: (n: number) => Uint8Array): Promise<{ key: string; hash: string; prefix: string }> {
  const key = API_KEY_PREFIX + base64url(randomBytes(32))
  return { key, hash: await hashApiKey(key), prefix: key.slice(0, 11) }
}

/** A key used more recently than this is not stamped again: one write a minute per key at most (CORE15). */
export const LAST_USED_THROTTLE_MS = 60_000

const KEY = 'auth:key'

/**
 * API-key authentication ([[CORE36]] D17, [[CORE41]] P6): ONE internal unit with no organisation (the key says which
 * organisation it is for). The plan read joins the key to its agent by hash. The rules are applied in the program,
 * against the unit's `now`: not revoked, not expired (`expires_at <= now` is expired), agent not disabled. A valid
 * key last used at least a minute ago, or never, gets ONE guarded update of `last_used_at` and nothing else:
 * no `updated_at`, no event (usage bookkeeping is not a change to the key; a named exception to invariant 5), and no
 * `expect`, because a racer may have stamped it already and that is fine. Everything else builds no statement.
 */
export function apiKeyAuthOperation(keyHash: string, now: Date): PreparedOperation<Principal | null> {
  const at = codecs.timestamp.write(now)
  const cutoff = codecs.timestamp.write(new Date(now.getTime() - LAST_USED_THROTTLE_MS))
  return defineOperation<Principal | null>({
    name: 'auth.api_key',
    mutates: true,
    reads: (qc) => ({
      [KEY]: readMaybe(
        qc.db
          .selectFrom('api_keys')
          .innerJoin('agents', 'agents.id', 'api_keys.agent_id')
          .select([
            'api_keys.id as key_id',
            'agents.id as agent_id',
            'agents.organization_id',
            'agents.scopes',
            'api_keys.last_used_at',
            'api_keys.expires_at',
            'api_keys.revoked_at',
            'agents.disabled_at',
          ])
          .where('api_keys.key_hash', '=', keyHash),
      ),
    }),
    build: (found, qc) => {
      const row = found.maybe(KEY)
      const expiresAt = row ? codecs.timestamp.readNullable(row.expires_at) : null
      const valid =
        row !== null &&
        codecs.timestamp.readNullable(row.revoked_at) === null &&
        codecs.timestamp.readNullable(row.disabled_at) === null &&
        (expiresAt === null || Date.parse(expiresAt) > now.getTime())
      if (!valid) return unit({ steps: [], events: [], decode: () => null })
      const lastUsed = codecs.timestamp.readNullable(row.last_used_at)
      const principal: Principal = {
        actor: { id: row.agent_id as string, kind: 'agent' },
        organizationId: row.organization_id as string,
        scopes: ScopeSet.parse(codecs.stringArray.read(row.scopes)),
      }
      const stale = lastUsed === null || Date.parse(lastUsed) < Date.parse(cutoff)
      if (!stale) return unit({ steps: [], events: [], decode: () => principal })
      const stamp = qc.db
        .updateTable('api_keys')
        .set({ last_used_at: at })
        .where('api_keys.id', '=', row.key_id as string)
        .where((eb) => eb.or([eb('api_keys.last_used_at', 'is', null), eb('api_keys.last_used_at', '<', cutoff)]))
      return unit({ steps: [step(stamp, 'first-mutation')], events: [], decode: () => principal })
    },
  })
}

/**
 * Looks the key up and (at most once a minute per key) records its use, in one internal unit. Unknown, revoked,
 * expired and disabled-agent keys are all `null`. The key is hashed BEFORE the unit (D10); only the hash is a parameter.
 */
export async function authenticateApiKey(storage: StorageBinding, key: string, env: InternalEnv): Promise<Principal | null> {
  const hash = await hashApiKey(key)
  return (await execute(storage, { kind: 'internal', organizationId: null }, apiKeyAuthOperation(hash, env.now))).value
}
