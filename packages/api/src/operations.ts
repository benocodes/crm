import { adminOperations } from './admin/operations.js'
import { accountOperations } from './account/operations.js'
import { identityOperations } from './identity/operations.js'
import { Registry } from './registry.js'
import { agents } from './resources/agents.js'
import { apiKeys } from './resources/api-keys.js'
import { companies } from './resources/companies.js'
import { contacts } from './resources/contacts.js'
import { identities } from './resources/identities.js'
import { memberships } from './resources/memberships.js'
import { tasks } from './resources/tasks.js'

/** A fresh registry per call: no module-level mutable registry. Later specs append here. */
export function createVaultRegistry(): Registry {
  const registry = new Registry().registerResource(tasks).registerResource(companies).registerResource(contacts).registerResource(identities)
  registry.registerResource(memberships).registerResource(agents).registerResource(apiKeys)
  for (const op of adminOperations()) registry.register(op)
  for (const op of identityOperations()) registry.register(op)
  for (const op of accountOperations()) registry.register(op)
  return registry
}
