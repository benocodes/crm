import { identityOperations } from './identity/operations.js'
import { Registry } from './registry.js'
import { companies } from './resources/companies.js'
import { contacts } from './resources/contacts.js'
import { identities } from './resources/identities.js'
import { tasks } from './resources/tasks.js'

/** A fresh registry per call: no module-level mutable registry. Later specs append here. */
export function createVaultRegistry(): Registry {
  const registry = new Registry().registerResource(tasks).registerResource(companies).registerResource(contacts).registerResource(identities)
  for (const op of identityOperations()) registry.register(op)
  return registry
}
