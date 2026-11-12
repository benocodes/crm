// [[API7]] D12, D13: the webhook configuration. STUB (red commit): nothing is configured; the parser follows in the implementation commit.

/** What the webhook operations need from the composition. `key` null: `create` and `rotate_secret` answer `501 webhooks_not_configured`. */
export interface WebhooksRuntime {
  key: { bytes: Uint8Array; version: number } | null
  allowInsecureUrls: boolean
}

export function parseWebhooksConfig(_env: Record<string, string | undefined>): { runtime: WebhooksRuntime; problems: string[] } {
  return { runtime: { key: null, allowInsecureUrls: false }, problems: [] }
}
