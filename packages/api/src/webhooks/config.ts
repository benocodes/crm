import { decodeBase64 } from '../connections/config.js'

// [[API7]] D12, D13, "Configuration": what the webhook operations need from the composition. `CREDENTIALS_KEY` and `CREDENTIALS_KEY_VERSION` are shared with [[CHN5]] D4 but are read
// here ON THEIR OWN: webhooks do not depend on the Gmail connect switch, which also needs three Google variables. A problem is a NAME, never a value.

/** `key` null: `create` and `rotate_secret` answer `501 webhooks_not_configured`. */
export interface WebhooksRuntime {
  key: { bytes: Uint8Array; version: number } | null
  /** `WEBHOOK_ALLOW_INSECURE_URLS=true`: `http://` and loopback targets (local development and the local E2E only). */
  allowInsecureUrls: boolean
}

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== ''

export function parseWebhooksConfig(env: Record<string, string | undefined>): { runtime: WebhooksRuntime; problems: string[] } {
  const problems: string[] = []
  let bytes: Uint8Array | null = null
  if (present(env.CREDENTIALS_KEY)) {
    bytes = decodeBase64(env.CREDENTIALS_KEY)
    if (bytes?.length !== 32) {
      bytes = null
      problems.push('CREDENTIALS_KEY')
    }
  }
  let version = 1
  if (env.CREDENTIALS_KEY_VERSION !== undefined) {
    const raw = env.CREDENTIALS_KEY_VERSION.trim()
    if (/^[1-9]\d{0,8}$/.test(raw)) version = Number(raw)
    else problems.push('CREDENTIALS_KEY_VERSION')
  }
  const key = bytes && !problems.includes('CREDENTIALS_KEY_VERSION') ? { bytes, version } : null
  return { runtime: { key, allowInsecureUrls: env.WEBHOOK_ALLOW_INSECURE_URLS === 'true' }, problems }
}

/** The startup log line: the names of the malformed variables, never a value. */
export const webhooksConfigNotice = (problems: readonly string[]): string => `[webhooks] webhook secrets are not available: fix ${problems.join(', ')}`
