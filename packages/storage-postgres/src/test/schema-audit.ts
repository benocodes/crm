// Test-only (spec CORE38 D10): reads the physical constraint shape of both engines and diffs them.
import type { Kysely } from 'kysely'
import type { D1Like } from '@vault/storage-d1'

export type Aspect = 'table' | 'primaryKey' | 'foreignKey' | 'uniqueKey' | 'index' | 'namedCheck'
export interface TableShape { primaryKey: string[]; foreignKeys: string[]; uniqueKeys: string[]; indexes: string[]; namedChecks: string[] }
export interface SchemaShape { tables: string[]; byTable: Record<string, TableShape> }
export interface EngineDifference { aspect: Aspect; engine: 'postgres' | 'd1'; table: string; item: string; reason: string; d1Fragment?: string }

const nope = (): never => {
  throw new Error('not implemented')
}
export function normalizePredicate(_sql: string | null): string { return nope() }
export function fkItem(_cols: string[], _refTable: string, _refCols: string[], _onDelete: string): string { return nope() }
export function uniqueItem(_cols: string[], _predicate: string | null): string { return nope() }
export function indexItem(_name: string, _cols: string[], _predicate: string | null): string { return nope() }
export function d1CheckNames(_createTableSql: string): string[] { return nope() }
export function diffShapes(_pg: SchemaShape, _d1: SchemaShape): EngineDifference[] { return nope() }
export async function postgresShape(_owner: Kysely<any>, _tables: readonly string[]): Promise<SchemaShape> { return nope() }
export async function d1Shape(_d1: D1Like, _tables: readonly string[]): Promise<SchemaShape> { return nope() }
export const ENGINE_DIFFERENCES: readonly EngineDifference[] = []
