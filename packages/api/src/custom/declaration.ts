// STUB (red commit): the declaration format of a custom object ([[CORE315]] D6, D9, D18, D19). Implemented in the green commit.
export type FieldKind = 'text' | 'integer' | 'boolean' | 'timestamp' | 'enum'
export interface FieldDeclaration {
  kind: FieldKind
  label?: string
  description?: string
  required?: boolean
  default?: string | number | boolean
  values?: string[]
}
export interface ObjectDeclaration {
  label?: string
  description?: string
  fields: Record<string, FieldDeclaration>
}
export class DeclarationError extends Error {
  constructor(
    readonly rule: string,
    message: string,
    readonly path: string = '',
  ) {
    super(message)
  }
}
export const RESERVED_NAMES: readonly string[] = []
export function parseObjectDeclaration(_key: string, _input: unknown): ObjectDeclaration {
  throw new Error('not implemented')
}
export function parseObjectDeclarations(_input: unknown): Record<string, ObjectDeclaration> {
  throw new Error('not implemented')
}
