// RED STUB (API63): the smallest module the tests can import. The real catalog lands in the green commit.
export interface ColumnText {
  label?: string
  description: string
}
export interface TableText {
  label: string
  description: string
  columns: Record<string, string | ColumnText>
}
export interface Catalog {
  tables: Record<string, TableText>
  common: Record<string, string>
}
export const CATALOG: Catalog = { tables: {}, common: {} }
export const HIDDEN_TABLES: readonly string[] = []
export const defaultLabel = (name: string): string => name
