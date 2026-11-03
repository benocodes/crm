import type { Command, JsonSchema, Operation } from './types.js'

export const RESERVED_FLAGS: readonly string[] = ['data', 'all', 'refresh', 'profile', 'server', 'output', 'help']

/** Merges the two OpenAPI documents by `operationId` ([[API6]] D7). A duplicate is a usage error naming both. */
export function mergeDocuments(_docs: { source: 'api' | 'meta'; doc: unknown }[]): Operation[] {
  throw new Error('not implemented')
}
export function deriveCommand(_op: Operation): Command {
  throw new Error('not implemented')
}
export function deriveCommands(_ops: Operation[]): Command[] {
  throw new Error('not implemented')
}
export type { JsonSchema }
