// `POST /gmail/push` ([[CHN5]] D15, D87, D88): Pub/Sub's authenticated push of a Gmail notification, and the sync it requests.
import type { Context } from 'hono'
import type { StorageBinding } from '@vault/storage'
import type { PushConfig } from '../../connections/config.js'
import type { MailSyncInstances } from '../../sync/request.js'

export const PUSH_PATH = '/gmail/push'
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

export interface PushDeps {
  /** Null: push is off, the route answers 404 ([[CHN5]] D87). */
  push: PushConfig | null
  fetch: typeof fetch
  instances?: MailSyncInstances
  storage: (c: Context) => StorageBinding
  clock?: () => Date
  newId?: () => string
}

export function gmailPushHandler(_d: PushDeps): (c: Context) => Promise<Response> {
  return async (c) => c.json({ error: { code: 'not_implemented', message: 'stub' } }, 500)
}
