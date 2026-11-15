// The narrow port the webhook operations, dispatch and sender reach the control plane through ([[CORE337]] P5, [[CORE259]] D5), as `invitations/port.ts` does. The Worker composition builds it over the control
// plane's webhook store and hands it in; nothing in this package names the control binding. Without it (`null`) the operations answer `501 provider_not_configured`, and dispatch and the sender do nothing.
// A subscription change is one control batch with its `control_audit` row (the store's job); facts that live in the CRM database arrive by value, read by the caller.
import type { WebhookStore } from '@vibase/storage-d1'

export type { WebhookStore as WebhooksPort }
export type {
  NewWebhookSubscription,
  WebhookChange,
  WebhookDeliveryOutcome,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookDispatchTarget,
  WebhookDueDelivery,
  WebhookStatus,
  WebhookSubscriptionRecord,
} from '@vibase/storage-d1'
