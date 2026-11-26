import { connectionOperations, withWatchStop, type ConnectionsRuntime } from './connections/operations.js'
import { contentOperations } from './messaging/content-operations.js'
import { adminOperations } from './admin/operations.js'
import { apiKeyOperations } from './admin/api-keys.js'
import type { ApiKeyStorePort } from './admin/api-key-port.js'
import { auditOperations } from './audit/operations.js'
import type { AuditRuntime } from './audit/port.js'
import { invitationOperations } from './invitations/operations.js'
import { resetLinkOperation, withMembershipWrites } from './members/operations.js'
import type { MembersRuntime } from './members/port.js'
import type { InvitationsRuntime } from './invitations/port.js'
import { oauthClientOperations } from './oauth-clients/operations.js'
import type { OAuthClientsRuntime } from './oauth-clients/port.js'
import { accountOperations } from './account/operations.js'
import { dealOperations } from './deals/operations.js'
import { identityOperations } from './identity/operations.js'
import { assertNeighbours, endpointTypesOf } from './associations/definition.js'
import { associationOperations } from './associations/operations.js'
import { schemaOperations } from './schema/operations.js'
import { eventOperations } from './events/operations.js'
import { Registry, type AnyResource } from './registry.js'
import { agents } from './resources/agents.js'
import { createBuiltIns, defaultBuiltIns } from './resources/built-ins.js'
import type { ExtendDeclarations } from './custom/extend.js'
import { companyFiles } from './resources/company-files.js'
import { connections } from './resources/connections.js'
import { contactFiles } from './resources/contact-files.js'
import { files } from './resources/files.js'
import { identities } from './resources/identities.js'
import { interactions } from './resources/interactions.js'
import { messages } from './resources/messages.js'
import { threads } from './resources/threads.js'
import { blockedSenders } from './resources/blocked-senders.js'
import { forms } from './resources/forms.js'
import { memberships } from './resources/memberships.js'
import { notes } from './resources/notes.js'
import { pipelineStages } from './resources/pipeline-stages.js'
import { pipelines } from './resources/pipelines.js'
import { tags } from './resources/tags.js'
import { actionRequests } from './action-requests/definition.js'
import { actionRequestOperations } from './action-requests/operations.js'
import { actionExecutions, executionReadOperations } from './executions/definition.js'
import { messageSendOperation } from './messaging/send.js'
import { webhookOperations } from './webhooks/operations.js'
import type { WebhooksRuntime } from './webhooks/config.js'

/**
 * A fresh registry per call: no module-level mutable registry. Later specs append here. `connections` is the Gmail configuration the
 * authorize operation reads ([[CHN5]] D58); the registry has the same operations whatever it is.
 */
export function createVibaseRegistry(
  options: {
    connections?: ConnectionsRuntime /** Operations registered before the queue's, so `action_requests.create` lists the proposable ones (Node tests and compositions that add an enqueued operation; the Worker passes none). */
    operations?: (
      registry: Registry,
    ) => void /** [[API7]] D12, D13: the webhook configuration (the credentials key, the insecure-URL switch). Absent: unconfigured; the operations are registered all the same. */
    webhooks?: WebhooksRuntime /** [[CORE245]] P2: the control-plane port of the invitation operations; absent or null: this composition has no control store and they answer `501 provider_not_configured`. The registry has them all the same. */
    invitations?: InvitationsRuntime | null /** [[CORE627]] D2, D10: the first-party OAuth clients' control-plane port, scope ceiling and resources; absent or null: they answer `501 provider_not_configured`. The registry has them all the same. */
    oauthClients?: OAuthClientsRuntime | null /** [[CORE288]] P1, P2: the membership writes' control-plane port; absent or null: they answer `501 provider_not_configured`. The registry has them all the same. */
    members?: MembersRuntime | null /** [[CORE261]] P1, P5: the audit log's read port; absent or null: `audit.list` answers `501 provider_not_configured`. The registry has it all the same. */
    audit?: AuditRuntime | null /** [[CORE351]] P5: the control-plane store of the four `api_keys.*` operations; absent or null: they answer `501 provider_not_configured`. The registry has them all the same. */
    apiKeys?: ApiKeyStorePort | null /** [[CORE315]] D23: the custom objects' definitions (`defineCustomObject`), registered before the queue's so `action_requests.create` lists their writes. Absent or empty: the registry of every deployment without one. */
    definitions?: readonly AnyResource[] /** [[CORE559]] P1: the validated `extend` of the schema file ([[CORE555]]'s validator output): the four built-ins' definitions are built from their declaration plus this, once, and every operation that names one of their records uses the same. Absent or empty: the definitions of a deployment without one. */
    extend?: ExtendDeclarations
  } = {},
): Registry {
  const b = options.extend ? createBuiltIns(options.extend) : defaultBuiltIns()
  const registry = new Registry()
    .registerResource(b.tasks)
    .registerResource(b.companies)
    .registerResource(b.contacts)
    .registerResource(identities)
    .registerResource(notes)
    .registerResource(tags)
  registry.registerResource(pipelines).registerResource(pipelineStages).registerResource(b.deals)
  registry.registerResource(connections)
  registry.registerResource(blockedSenders)
  registry.registerResource(forms)
  registry.decorate('connections.delete', (op) => withWatchStop(op, options.connections ?? null))
  for (const op of connectionOperations(options.connections ?? null)) registry.register(op)
  for (const op of dealOperations(b)) registry.register(op)
  registry
    .registerResource(threads)
    .registerResource(messages)
    .registerResource(interactions)
    .registerResource(files)
    .registerResource(contactFiles)
    .registerResource(companyFiles)
  assertNeighbours(endpointTypesOf(registry.resources()))
  for (const op of associationOperations(() => registry.resources())) registry.register(op)
  for (const op of contentOperations()) registry.register(op)
  registry.registerResource(memberships).registerResource(agents)
  // [[CORE288]]: the generated membership writes get their control-plane stages; the reset link is a hand-written operation beside `users.list`.
  const memberWrites = withMembershipWrites(memberships, options.members ?? null)
  registry.decorate('memberships.update', memberWrites.update).decorate('memberships.delete', memberWrites.delete)
  // [[API6]] D4: the feed's visibility map. Definitions register their own `eventName`; these are the types no definition names or that the feed hides.
  registry.registerEventType('association', { scope: 'associations', edge: true })
  registry.registerEventType('organization', { scope: 'members' })
  for (const op of adminOperations()) registry.register(op)
  for (const op of apiKeyOperations(options.apiKeys ?? null)) registry.register(op)
  for (const op of invitationOperations(options.invitations ?? null)) registry.register(op)
  for (const op of oauthClientOperations(options.oauthClients ?? null)) registry.register(op)
  for (const op of auditOperations(options.audit ?? null)) registry.register(op)
  registry.register(resetLinkOperation(options.members ?? null))
  for (const op of identityOperations(b, options.definitions ?? [])) registry.register(op)
  for (const op of accountOperations()) registry.register(op)
  options.operations?.(registry)
  // [[CORE315]] D23: before the queue's operations, like every proposable one (the `operation` enum of `action_requests.create` lists what is registered by then).
  for (const def of options.definitions ?? []) registry.registerResource(def)
  registry.register(messageSendOperation())
  // [[AGT8]] D33: last, because the `operation` enum of `action_requests.create` lists the proposal-eligible operations registered before it.
  registry.registerResource(actionRequests)
  registry.registerEventType('action_request', {
    invisible:
      "visibility is per row (the target operation's authority, AGT8 D38/D57), not per type: a row predicate is #217",
  })
  for (const op of actionRequestOperations(registry)) registry.register(op)
  // [[AGT8]] D57: the execution reads, after every enqueued operation so a caller's readable set is the registry's whole.
  registry.registerResource(actionExecutions)
  registry.registerEventType('action_execution', {
    invisible:
      "visibility is per row (the target operation's authority, AGT8 D57), not per type: a row predicate is #217",
  })
  for (const op of executionReadOperations(registry)) registry.register(op)
  for (const op of schemaOperations(() => registry.resources())) registry.register(op)
  for (const op of eventOperations(() => registry)) registry.register(op)
  // [[CORE347]] P1: no `webhook` entry. Subscriptions live in the control plane and their changes are in the audit log (`audit.list`), not the feed; historic `webhook.*` rows are invisible (no entry fails closed).
  for (const op of webhookOperations(options.webhooks ?? null, () => registry)) registry.register(op)
  return registry
}
