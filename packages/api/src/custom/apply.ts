// STUB (red commit): apply. Replaced by the implementation.
import type { D1Like } from '@vibase/storage-d1'
import type { ObjectDeclaration } from './declaration.js'
export interface Refusal {
  rule: string
  object: string
  field?: string
  message: string
  value?: unknown
  ids?: string[]
}
export interface ApplyReport {
  created: string[]
  added: { object: string; field: string }[]
  indexed: { object: string; index: string }[]
  archived: { object: string; field?: string }[]
  refused: Refusal[]
  statements: number
}
export async function applyExtensions(_d1: D1Like, _objects: Record<string, ObjectDeclaration>): Promise<ApplyReport> {
  return { created: [], added: [], indexed: [], archived: [], refused: [], statements: 0 }
}
