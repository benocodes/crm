// STUB (red commit): replaced by the implementation.
import type { PreparedOperation } from '@vault/storage'
import type { PreparedEnv } from '../storage/definition.js'

export interface ConnectInput {
  google_sub: string
  mailbox: string
  own_addresses: readonly string[]
  granted_scopes: readonly string[]
  ciphertext: string
  key_version: number
  history_id: string
}
export interface ConnectResult {
  connection_id: string
  created: boolean
}
export function connectOperation(_env: PreparedEnv, _input: ConnectInput): PreparedOperation<ConnectResult> {
  throw new Error('not implemented')
}
