// Stub for the red commit ([[CORE555]]): the real validator follows.
import type { FieldDeclaration } from './declaration.js'
export const EXTENSIBLE_OBJECTS = ['contacts', 'companies', 'deals', 'tasks'] as const
export type ExtensibleObject = (typeof EXTENSIBLE_OBJECTS)[number]
export type ExtendDeclarations = Partial<Record<ExtensibleObject, Record<string, FieldDeclaration>>>
export function parseExtend(_input: unknown, _customKeys: readonly string[] = []): ExtendDeclarations {
  throw new Error('not implemented')
}
