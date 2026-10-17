import { Registry } from './registry.js'
import { tasks } from './resources/tasks.js'

/** A fresh registry per call: no module-level mutable registry. Later specs append here. */
export function createVaultRegistry(): Registry {
  return new Registry().registerResource(tasks)
}
