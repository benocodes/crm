import type { Context } from 'hono'
import type { AuthAdapter } from '../auth/adapter.js'
import type { AppEnv } from '../rest/app.js'
import { internalEnv } from '../storage/internal.js'
import { reconcileOrganization, refreshUser } from './sync.js'

/**
 * `POST /webhooks/clerk` ([[CORE3]] D18, D23): the signature is the only credential, so there is no auth
 * middleware. A delivery is a hint: the handler fetches current state and reconciles, so duplicate and
 * out-of-order deliveries are harmless. A failure is a non-2xx and the provider retries (a fetch failure 500, drift 409,
 * a snapshot over the cap 400). On D1 a delivery for another provider organisation is acknowledged and ignored before
 * any fetch or SQL ([[CORE36]] D19): a deployment serves one organisation.
 */
export function clerkWebhookHandler(
  adapter: AuthAdapter,
  deps: { clock?: () => Date; newId?: () => string } = {},
): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    const parsed = await adapter.parseWebhook({ headers: c.req.raw.headers, body: await c.req.text() })
    if (!parsed.ok) {
      console.warn('[directory] webhook 401', { reason: parsed.reason })
      return c.json({ error: { code: 'unauthenticated', message: 'invalid webhook signature' } }, 401)
    }
    const { change } = parsed
    if (change.kind === 'ignored') return c.json({ received: true }, 200)
    const storage = c.var.storage
    if (!storage) throw new Error('POST /webhooks/clerk needs a storage binding, but createApp was given none')
    const env = internalEnv(deps)
    if (change.kind === 'organization') {
      if (storage.kind === 'd1' && (adapter.provider !== storage.authProvider || change.externalId !== storage.authOrgId)) {
        return c.json({ received: true }, 200)
      }
      await reconcileOrganization(storage, adapter, change.externalId, env)
    } else {
      await refreshUser(storage, adapter, change.subject, env)
    }
    return c.json({ received: true }, 200)
  }
}
