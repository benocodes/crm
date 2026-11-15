// The narrow port the webhook operations, dispatch and sender reach the control plane through ([[CORE337]] P5, [[CORE259]] D5), as `invitations/port.ts` does, with its own types: nothing in this package
// imports the control plane's store. Composition builds it over the store's webhook methods and hands it in (a structural fit, checked where it is assigned). Without it (`null`) the operations answer
// `501 provider_not_configured`, and dispatch and the sender do nothing. A subscription change is one control batch with its `control_audit` row (the store's job); facts that live in the CRM database
// arrive by value, read by the caller. Timestamps are ISO-8601 text.

export type WebhookStatus = 'active' | 'paused' | 'disabled'
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'dead' | 'cancelled'
export interface WebhookSubscriptionRecord {
  id: string
  organizationId: string
  agentId: string
  url: string
  eventTypes: string[]
  status: WebhookStatus
  createdBy: string
  createdAt: string
  updatedAt: string
}
export interface WebhookDeliveryRecord {
  id: string
  subscriptionId: string
  eventId: string
  eventType: string
  status: WebhookDeliveryStatus
  attempts: number
  nextAttemptAt: string
  lastAttemptAt: string | null
  lastStatusCode: number | null
  lastError: string | null
  deliveredAt: string | null
  createdAt: string
}

export interface WebhookDispatchTarget {
  subscriptionId: string
  createdBy: string
  agentId: string
  eventTypes: string[]
  cursor: string
}
export interface WebhookDueDelivery {
  id: string
  subscriptionId: string
  eventId: string
  /** Attempts before this claim. */
  attempts: number
  url: string
  deleted: boolean
  agentId: string
}
export type WebhookDeliveryOutcome =
  | { id: string; subscriptionId: string; kind: 'delivered'; statusCode: number }
  | {
      id: string
      subscriptionId: string
      kind: 'failed'
      code: string
      statusCode: number | null
      nextAttemptAt: string | null
      dead: boolean
    }
  | { id: string; subscriptionId: string; kind: 'cancelled'; code: string }
export interface NewWebhookSubscription {
  id: string
  secretId: string
  auditId: string
  organizationId: string
  /** The calling principal: `created_by` of every row and the audit `actor_id`. */
  actorId: string
  agentId: string
  url: string
  eventTypes: string[]
  /** The secret, sealed by the caller under `CREDENTIALS_KEY`. */
  sealed: string
  keyVersion: number
  /** The newest event's id, read by the caller from the CRM feed: the dispatch position at creation ([[API7]] D5). */
  cursorEventId: string
  /** [[API7]] D16: the caller's limit of live subscriptions per agent. */
  maxLivePerAgent: number
  now: string
}
export interface WebhookChange {
  id: string
  auditId: string
  actorId: string
  now: string
  /** The `updated_at` the caller read: the write applies only while the row still carries it. */
  expectedUpdatedAt: string
  /** An agent caller's own id: a subscription of another agent is `not_found` ([[API7]] D1). */
  ownerAgentId?: string
}

export interface WebhooksPort {
  /** `limit`: the agent already holds `maxLivePerAgent` live subscriptions; nothing was written. */
  create(a: NewWebhookSubscription): Promise<'created' | 'limit'>
  /** `not_found`: missing, deleted or another agent's; `drifted`: the row moved since `expectedUpdatedAt`. Nothing is written in either case. */
  update(
    a: WebhookChange & { url?: string; eventTypes?: string[]; status?: 'active' | 'paused' },
  ): Promise<'updated' | 'not_found' | 'drifted'>
  delete(a: WebhookChange): Promise<'deleted' | 'not_found' | 'drifted'>
  rotateSecret(a: {
    id: string
    secretId: string
    auditId: string
    actorId: string
    sealed: string
    keyVersion: number
    now: string
    ownerAgentId?: string
  }): Promise<'rotated' | 'not_found'>
  get(a: { id: string; ownerAgentId?: string }): Promise<WebhookSubscriptionRecord | null>
  list(a: {
    ownerAgentId?: string
    agentId?: string
    after?: string
    limit: number
  }): Promise<WebhookSubscriptionRecord[]>
  /** `null`: the subscription is not visible to the caller. */
  deliveries(a: {
    subscriptionId: string
    ownerAgentId?: string
    status?: WebhookDeliveryStatus
    after?: string
    limit: number
  }): Promise<WebhookDeliveryRecord[] | null>
  secrets(a: {
    subscriptionIds: string[]
    inForceAt?: string
  }): Promise<Array<{ subscriptionId: string; sealed: string; createdAt: string }>>
  dispatchable(a: { organizationId: string; eligibleAgentIds: string[] }): Promise<WebhookDispatchTarget[]>
  applyPage(a: {
    organizationId: string
    subscriptionId: string
    createdBy: string
    expectedCursor: string
    events: Array<{ id: string; eventId: string; eventType: string }>
    now: string
  }): Promise<{ moved: boolean }>
  claim(a: {
    organizationId: string
    cutoff: string
    now: string
    limit: number
    caps: Record<string, number>
    defaultCap: number
    maxAttempts: number
    token: string
    leaseUntil: string
  }): Promise<{ rows: WebhookDueDelivery[]; dead: number; totalDue: number }>
  record(a: { token: string; at: string; outcomes: WebhookDeliveryOutcome[] }): Promise<boolean[]>
}
