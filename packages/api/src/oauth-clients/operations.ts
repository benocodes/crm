import type { ControlOperation } from '../registry.js'
import type { OAuthClientsRuntime } from './port.js'

export function oauthClientOperations(_runtime: OAuthClientsRuntime | null): ControlOperation[] {
  return []
}
