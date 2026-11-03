// Stub (red commit): the implementation follows.
import type { AgentRecord, Me } from './types.js'

export interface ApiResult<T> {
  status: number
  body: T | null
}
export interface Api {
  me(): Promise<ApiResult<Me>>
  agents(): Promise<ApiResult<AgentRecord[]>>
  setDisabled(id: string, disabled: boolean): Promise<ApiResult<AgentRecord>>
}

export function createApi(_deps: { origin: string; getToken(): Promise<string | null>; fetch: typeof fetch }): Api {
  const none = async () => ({ status: 0, body: null })
  return { me: none, agents: none, setDisabled: none }
}
