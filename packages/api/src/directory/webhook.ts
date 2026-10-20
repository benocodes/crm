import type { Context } from 'hono'
import type { AuthAdapter } from '../auth/adapter.js'
import type { AppEnv } from '../rest/app.js'
import { reconcileOrganization, refreshUser } from './sync.js'

/**
 * `POST /webhooks/clerk` ([[CORE3]] D18, D23): the signature is the only credential, so there is no auth
 * middleware. A delivery is a hint: the handler fetches current state and reconciles, so duplicate and
 * out-of-order deliveries are harmless. A failure is a 500 and the provider retries.
 */
export function clerkWebhookHandler(adapter: AuthAdapter): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    const parsed = await adapter.parseWebhook({ headers: c.req.raw.headers, body: await c.req.text() })
    if (!parsed.ok) {
      console.warn('[directory] webhook 401', { reason: parsed.reason })
      return c.json({ error: { code: 'unauthenticated', message: 'invalid webhook signature' } }, 401)
    }
    const { change } = parsed
    if (change.kind === 'organization') await reconcileOrganization(c.var.db, adapter, change.externalId)
    else if (change.kind === 'user') await refreshUser(c.var.db, adapter, change.subject)
    return c.json({ received: true }, 200)
  }
}
