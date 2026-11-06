import { connectionOperations, withWatchStop, type ConnectionsRuntime } from './connections/operations.js'
import { contentOperations } from './messaging/content-operations.js'
import { adminOperations } from './admin/operations.js'
import { accountOperations } from './account/operations.js'
import { dealOperations } from './deals/operations.js'
import { identityOperations } from './identity/operations.js'
import { assertNeighbours, endpointTypesOf } from './associations/definition.js'
import { associationOperations } from './associations/operations.js'
import { schemaOperations } from './schema/operations.js'
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

/**
 * A fresh registry per call: no module-level mutable registry. Later specs append here. `connections` is the Gmail configuration the
 * authorize operation reads ([[CHN5]] D58); the registry has the same operations whatever it is.
 */
export function createVaultRegistry(options: { connections?: ConnectionsRuntime } = {}): Registry {
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
  for (const op of adminOperations()) registry.register(op)
  for (const op of identityOperations()) registry.register(op)
  for (const op of accountOperations()) registry.register(op)
  for (const op of schemaOperations(() => registry.resources())) registry.register(op)
  return registry
}
