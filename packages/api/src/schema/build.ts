// RED STUB (API63)
import type { AnyResource } from '../registry.js'
import type { Catalog } from './catalog.js'
export interface ColumnRow {
  table_name: string
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}
export interface ForeignKeyRow {
  table_name: string
  id: number
  seq: number
  ref_table: string
  from: string
  to: string | null
  on_delete: string
}
export interface BuildInput {
  columns: readonly ColumnRow[]
  foreignKeys: readonly ForeignKeyRow[]
  resources: readonly AnyResource[]
  catalog?: Catalog
  kinds?: Record<string, Record<string, string>>
  hidden?: readonly string[]
}
export function resourcesByTable(_defs: readonly AnyResource[]): Map<string, AnyResource> {
  throw new Error('not implemented')
}
export function buildSchemaDocument(_input: BuildInput): any {
  throw new Error('not implemented')
}
