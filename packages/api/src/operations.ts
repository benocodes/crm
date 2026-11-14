import { connectionOperations, withWatchStop, type ConnectionsRuntime } from './connections/operations.js'
import { contentOperations } from './messaging/content-operations.js'
import { adminOperations } from './admin/operations.js'
import { invitationOperations } from './invitations/operations.js'
import type { InvitationsRuntime } from './invitations/port.js'
import { accountOperations } from './account/operations.js'
import { dealOperations } from './deals/operations.js'
import { identityOperations } from './identity/operations.js'
import { assertNeighbours, endpointTypesOf } from './associations/definition.js'
import { associationOperations } from './associations/operations.js'
import { schemaOperations } from './schema/operations.js'
import { eventOperations } from './events/operations.js'
import { Registry } from './registry.js'
import { agents } from './resources/agents.js'
import { apiKeys } from './resources/api-keys.js'
import { companies } from './resources/companies.js'
import { companyFiles } from './resources/company-files.js'
import { connections } from './resources/connections.js'
import { contactFiles } from './resources/contact-files.js'
import { contacts } from './resources/contacts.js'
import { files } from './resources/files.js'
import { identities } from './resources/identities.js'
import { interactions } from './resources/interactions.js'
import { messages } from './resources/messages.js'
import { threads } from './resources/threads.js'
import { memberships } from './resources/memberships.js'
import { notes } from './resources/notes.js'
import { deals } from './resources/deals.js'
import { pipelineStages } from './resources/pipeline-stages.js'
import { pipelines } from './resources/pipelines.js'
import { tags } from './resources/tags.js'
import { tasks } from './resources/tasks.js'
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
export function createVibaseRegistry(options: { connections?: ConnectionsRuntime; /** Operations registered before the queue's, so `action_requests.create` lists the proposable ones (Node tests and compositions that add an enqueued operation; the Worker passes none). */ operations?: (registry: Registry) => void; /** [[API7]] D12, D13: the webhook configuration (the credentials key, the insecure-URL switch). Absent: unconfigured; the operations are registered all the same. */ webhooks?: WebhooksRuntime; /** [[CORE245]] P2: the control-plane port of the invitation operations; absent or null: this composition has no control store and they answer `501 provider_not_configured`. The registry has them all the same. */ invitations?: InvitationsRuntime | null } = {}): Registry {
  const registry = new Registry().registerResource(tasks).registerResource(companies).registerResource(contacts).registerResource(identities).registerResource(notes).registerResource(tags)
  registry.registerResource(pipelines).registerResource(pipelineStages).registerResource(deals)
  registry.registerResource(connections)
  registry.decorate('connections.delete', (op) => withWatchStop(op, options.connections ?? null))
  for (const op of connectionOperations(options.connections ?? null)) registry.register(op)
  for (const op of dealOperations()) registry.register(op)
  registry.registerResource(threads).registerResource(messages).registerResource(interactions).registerResource(files).registerResource(contactFiles).registerResource(companyFiles)
  assertNeighbours(endpointTypesOf(registry.resources()))
  for (const op of associationOperations(() => registry.resources())) registry.register(op)
  for (const op of contentOperations()) registry.register(op)
  registry.registerResource(memberships).registerResource(agents).registerResource(apiKeys)
  // [[API6]] D4: the feed's visibility map. Definitions register their own `eventName`; these are the types no definition names or that the feed hides.
  registry.registerEventType('association', { scope: 'associations', edge: true })
  registry.registerEventType('organization', { scope: 'members' })
  for (const op of adminOperations()) registry.register(op)
  for (const op of invitationOperations(options.invitations ?? null)) registry.register(op)
  for (const op of identityOperations()) registry.register(op)
  for (const op of accountOperations()) registry.register(op)
  options.operations?.(registry)
  registry.register(messageSendOperation())
  // [[AGT8]] D33: last, because the `operation` enum of `action_requests.create` lists the proposal-eligible operations registered before it.
  registry.registerResource(actionRequests)
  registry.registerEventType('action_request', { invisible: 'visibility is per row (the target operation\'s authority, AGT8 D38/D57), not per type: a row predicate is #217' })
  for (const op of actionRequestOperations(registry)) registry.register(op)
  // [[AGT8]] D57: the execution reads, after every enqueued operation so a caller's readable set is the registry's whole.
  registry.registerResource(actionExecutions)
  registry.registerEventType('action_execution', { invisible: 'visibility is per row (the target operation\'s authority, AGT8 D57), not per type: a row predicate is #217' })
  for (const op of executionReadOperations(registry)) registry.register(op)
  for (const op of schemaOperations(() => registry.resources())) registry.register(op)
  for (const op of eventOperations(() => registry)) registry.register(op)
  // [[API7]] D2, D19, D22: the webhook subscriptions. `webhooks:read` shows their events; an agent sees only its own subscriptions' (the record's `agent_id`), a user holding the scope all.
  registry.registerEventType('webhook', { scope: 'webhooks', owner: { path: '$.agent_id' } })
  for (const op of webhookOperations(options.webhooks ?? null, () => registry)) registry.register(op)
  return registry
}
