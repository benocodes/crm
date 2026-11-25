// STUB (red commit): replaced by the SDK-backed adapter.
import type { ActionRequest } from './format.js'

export interface Api {
  list(status: string): Promise<ActionRequest[]>
  get(id: string): Promise<ActionRequest>
  approve(id: string, reason?: string): Promise<ActionRequest>
  reject(id: string, reason?: string): Promise<ActionRequest>
}
export function createApi(_apiOrigin: string, _getToken: () => Promise<string | null>, _fetchImpl?: typeof fetch): Api {
  throw new Error('not implemented')
}
