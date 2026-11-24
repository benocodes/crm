// STUB (red commit): the extensions file's envelope. Replaced by the implementation.
import type { ObjectDeclaration } from './declaration.js'
export const MAX_FILE_BYTES = 256 * 1024
export interface ExtensionsFile {
  version: 1
  $schema?: string
  objects: Record<string, ObjectDeclaration>
}
export function parseExtensionsFile(_text: string): ExtensionsFile {
  return { version: 1, objects: {} }
}
export function extensionsJsonSchema(): Record<string, unknown> {
  return {}
}
