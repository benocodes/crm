import type { D1Like } from '@vault/storage-d1'

export interface BootstrapD1Options {
  organizationName: string
  email: string
  userName?: string
  agentName: string
  scopes?: readonly string[]
  authProvider?: string
  authOrgId: string
  authSubject?: string
  organizationId?: string
}
export interface BootstrapD1Result {
  organizationId: string
  userId: string
  agentId: string
  apiKeyId: string
  key: string
  deployment: 'created' | 'existing'
}

export function bootstrapD1(
  _d1: D1Like,
  _opts: BootstrapD1Options,
  _env: { now?: Date; newId?: () => string; randomBytes?: (n: number) => Uint8Array } = {},
): Promise<BootstrapD1Result> {
  throw new Error('not implemented')
}
