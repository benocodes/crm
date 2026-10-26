import type { PreparedOperation } from '@vault/storage'
import type { PreparedEnv } from '../storage/definition.js'

// ---- CORE36 stubs (replaced in Phase 3) ----
export function deleteCompanyOperation(_env: PreparedEnv, _id: string): PreparedOperation<void> {
  throw new Error('not implemented')
}
export function deleteContactOperation(_env: PreparedEnv, _id: string): PreparedOperation<void> {
  throw new Error('not implemented')
}
