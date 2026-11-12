// The vault client. Stub: the red commit ([[API221]]).
export interface VaultDeps {
  baseUrl: string
  apiKey: string
  fetch: typeof fetch
  nonRetryable: (message: string) => Error
}
export interface Vault {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
}
export function createVault(_deps: VaultDeps): Vault {
  throw new Error('not implemented')
}
export const REQUIRED_SCOPES: string[] = []
