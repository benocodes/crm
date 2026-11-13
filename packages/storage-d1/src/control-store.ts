// The control store ([[CORE259]] D5): STUB at the red commit.
import type { D1Like } from './binding.js'

export type ControlDb = never
export const openControlDb = (_d1: D1Like): ControlDb => {
  throw new Error('not implemented')
}
export const readControlMarker = async (_c: ControlDb): Promise<{ organizationId: string } | null> => {
  throw new Error('not implemented')
}
export const writeControlMarker = async (_c: ControlDb, _organizationId: string): Promise<'created' | 'existing'> => {
  throw new Error('not implemented')
}
export const controlAuthDatabase = (_c: ControlDb): { prepare(query: string): unknown } => {
  throw new Error('not implemented')
}
export const readControlMigrations = async (_c: ControlDb) => {
  throw new Error('not implemented')
}
