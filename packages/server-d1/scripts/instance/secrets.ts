export interface Secrets {
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_API_TOKEN: string
  /** Replaces every secret value in `text` (a wrangler failure's output) before it is printed. */
  redact(text: string): string
}
export function defaultSecretsPath(_env: Record<string, string | undefined>, _homedir: string, _envName: string): string {
  throw new Error('not implemented')
}
export function parseDotenv(_text: string): Record<string, string> {
  throw new Error('not implemented')
}
export function loadSecrets(_path: string, _env: Record<string, string | undefined>): Secrets {
  throw new Error('not implemented')
}
