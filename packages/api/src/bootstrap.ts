import type { PreparedOperation, StorageBinding } from '@vault/storage'

const nope = (): never => {
  throw new Error('not implemented')
}
export type BootstrapResult = { organizationId: string; userId: string; agentId: string; apiKeyId: string; key: string }
export type BootstrapArgs = Record<string, never>
export function bootstrapOperation(_a: BootstrapArgs): PreparedOperation<BootstrapResult> {
  return nope()
}
export async function bootstrap(
  _storage: StorageBinding,
  _opts: {
    organizationName: string
    email: string
    userName?: string
    agentName: string
    scopes?: readonly string[]
    authProvider?: string
    authSubject?: string
  },
  _env?: { now?: Date; newId?: () => string; randomBytes?: (n: number) => Uint8Array },
): Promise<BootstrapResult> {
  return nope()
}
