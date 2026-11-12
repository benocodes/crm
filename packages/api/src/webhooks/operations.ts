import type { Registry, TenantOperation } from '../registry.js'
import type { WebhooksRuntime } from './config.js'

/** `webhooks.*` ([[API7]] D22). STUB (red commit): registers nothing. */
export function webhookOperations(_runtime: WebhooksRuntime | null, _registry: () => Registry): TenantOperation[] {
  return []
}
