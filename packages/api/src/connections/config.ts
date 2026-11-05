// STUB (red commit): replaced by the implementation.
export interface GmailConfig {
  clientId: string
  clientSecret: string
  stateSecret: string
  credentialsKey: Uint8Array
  keyVersion: number
  publicBaseUrl: string | null
  returnUrl: string | null
}
export function parseGmailConfig(_env: Record<string, string | undefined>): { config: GmailConfig | null; problems: string[] } {
  throw new Error('not implemented')
}
export function gmailConfigNotice(_problems: readonly string[]): string {
  throw new Error('not implemented')
}
