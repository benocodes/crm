// The token resolver ([[CHN5]] D4, D68): built per page call. It opens the connection's newest credential, does the vault's one refresh POST lazily
// on the first Gmail call, keeps the access token in memory for that page only, and rotates the credential (insert the new row, delete older rows,
// one unit) when Google returns a new refresh token. Errors carry a short code only: never a token, the key or provider text.
import { defineOperation, execute, readMaybe, step, unit, type StorageBinding } from '@vault/storage'
import { sealToken, openToken } from '../../connections/credentials.js'
import { GoogleRefreshError, refreshAccessToken, GOOGLE_ENDPOINTS, type GoogleEndpoints } from '../../connections/google.js'

/** A resolver failure that is not Google's verdict on the grant (that is a `GoogleRefreshError`). */
export class GmailCredentialError extends Error {
  override name = 'GmailCredentialError'
  constructor(readonly code: 'credential_key_mismatch' | 'no_credential' | 'credential_unreadable') {
    super(`Gmail credential unavailable: ${code}`)
  }
}

export interface TokenResolverDeps {
  binding: StorageBinding
  organizationId: string
  connectionId: string
  /** The connection's owner: the actor of the rotation unit ([[CHN5]] D21). */
  ownerId: string
  clientId: string
  clientSecret: string
  credentialsKey: Uint8Array
  keyVersion: number
  endpoints?: GoogleEndpoints
  fetch?: typeof fetch
  clock: () => Date
  newId: () => string
  randomBytes: (n: number) => Uint8Array
}

export function gmailAccessToken(d: TokenResolverDeps): () => Promise<string> {
  let pending: Promise<string> | null = null
  return () => (pending ??= resolve(d))
}

async function resolve(d: TokenResolverDeps): Promise<string> {
  const identity = { kind: 'tenant' as const, actorId: d.ownerId, organizationId: d.organizationId }
  const read = defineOperation<{ id: string; refresh_token_ciphertext: string; key_version: number } | null>({
    name: 'gmail.read_credential',
    mutates: false,
    reads: (qc) => ({
      credential: readMaybe(
        qc.db
          .selectFrom('channel_credentials')
          .select(['channel_credentials.id', 'channel_credentials.refresh_token_ciphertext', 'channel_credentials.key_version'])
          .where('channel_credentials.connection_id', '=', d.connectionId)
          .where('channel_credentials.organization_id', '=', d.organizationId)
          .orderBy('channel_credentials.created_at', 'desc')
          .orderBy('channel_credentials.id', 'desc')
          .limit(1),
      ),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const row = found.maybe('credential')
          return row ? { id: String(row.id), refresh_token_ciphertext: String(row.refresh_token_ciphertext), key_version: Number(row.key_version) } : null
        },
      }),
  })
  const credential = (await execute(d.binding, identity, read)).value
  if (!credential) throw new GmailCredentialError('no_credential')
  if (credential.key_version !== d.keyVersion) throw new GmailCredentialError('credential_key_mismatch')
  let refreshToken: string
  try {
    refreshToken = await openToken(d.credentialsKey, credential.refresh_token_ciphertext)
  } catch {
    throw new GmailCredentialError('credential_unreadable')
  }
  const refreshed = await refreshAccessToken({ endpoints: d.endpoints ?? GOOGLE_ENDPOINTS, clientId: d.clientId, clientSecret: d.clientSecret, refreshToken, fetch: d.fetch ?? ((i, n) => fetch(i, n)) })
  if (refreshed.refreshToken !== null && refreshed.refreshToken !== refreshToken) {
    const ciphertext = await sealToken(d.credentialsKey, refreshed.refreshToken, d.randomBytes(12))
    const at = d.clock().toISOString()
    const newId = d.newId()
    const rotate = defineOperation<void>({
      name: 'gmail.rotate_credential',
      mutates: true,
      reads: () => ({}),
      build: (_found, qc) =>
        unit({
          steps: [
            step(qc.db.insertInto('channel_credentials').values({ id: newId, organization_id: d.organizationId, created_by: d.ownerId, created_at: at, connection_id: d.connectionId, refresh_token_ciphertext: ciphertext, key_version: d.keyVersion })),
            step(qc.db.deleteFrom('channel_credentials').where('connection_id', '=', d.connectionId).where('organization_id', '=', d.organizationId).where('id', '!=', newId)),
          ],
          events: [],
          decode: () => undefined,
        }),
    })
    await execute(d.binding, identity, rotate)
  }
  return refreshed.accessToken
}

export { GoogleRefreshError }
