// The Gmail surface's configuration ([[CHN5]] D58, "Configuration"). The surface is configured when the four required values are set and
// `CREDENTIALS_KEY` decodes (base64) to exactly 32 bytes; anything else is a problem NAMED here, never a value (the notice is logged).

export interface GmailConfig {
  clientId: string
  clientSecret: string
  stateSecret: string
  /** The AES-256 key, decoded. */
  credentialsKey: Uint8Array
  /** `CREDENTIALS_KEY_VERSION`, default 1: stored beside each ciphertext so a key can rotate. */
  keyVersion: number
  /** `PUBLIC_BASE_URL` without a trailing slash; null when unset (the redirect URI then uses the request's origin). */
  publicBaseUrl: string | null
  /** `CONNECT_RETURN_URL`: where the callback redirects; null shows the built-in page ([[CHN5]] D32). */
  returnUrl: string | null
  /** `GMAIL_BACKFILL_DAYS`, default 30 ([[CHN5]] D71). */
  backfillDays: number
  /** `ATTACHMENT_MAX_BYTES`, default 50 MiB ([[CORE25]] D38). */
  attachmentMaxBytes: number
}

const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY'] as const

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== ''

/** base64 (standard alphabet, padded) to bytes; null when it is not base64. */
function decodeBase64(text: string): Uint8Array | null {
  const t = text.trim()
  if (t.length === 0 || t.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null
  try {
    return Uint8Array.from(atob(t), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** Reads the Gmail configuration from the Worker's variables. `config` is null unless every required value is set and well formed. */
export function parseGmailConfig(env: Record<string, string | undefined>): { config: GmailConfig | null; problems: string[] } {
  const problems: string[] = REQUIRED.filter((name) => !present(env[name]))
  let key: Uint8Array | null = null
  if (present(env.CREDENTIALS_KEY)) {
    key = decodeBase64(env.CREDENTIALS_KEY)
    if (key?.length !== 32) problems.push('CREDENTIALS_KEY')
  }
  let keyVersion = 1
  if (env.CREDENTIALS_KEY_VERSION !== undefined) {
    const raw = env.CREDENTIALS_KEY_VERSION.trim()
    if (!/^[1-9]\d{0,8}$/.test(raw)) problems.push('CREDENTIALS_KEY_VERSION')
    else keyVersion = Number(raw)
  }
  if (problems.length > 0) return { config: null, problems: [...new Set(problems)] }
  return {
    config: {
      clientId: env.GOOGLE_CLIENT_ID!.trim(),
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
      stateSecret: env.OAUTH_STATE_SECRET!,
      credentialsKey: key!,
      keyVersion,
      publicBaseUrl: present(env.PUBLIC_BASE_URL) ? env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '') : null,
      returnUrl: present(env.CONNECT_RETURN_URL) ? env.CONNECT_RETURN_URL.trim() : null,
      backfillDays: 30,
      attachmentMaxBytes: 50 * 1024 * 1024,
    },
    problems: [],
  }
}

/** The startup log line: the names of the missing or malformed variables, never a value. */
export function gmailConfigNotice(problems: readonly string[]): string {
  return `[gmail] Gmail connections are not available: set or fix ${problems.join(', ')}`
}

/** True when none of the required values is set at all: Gmail is simply off, which is not worth a log line. */
export const gmailUnconfigured = (problems: readonly string[]): boolean => REQUIRED.every((name) => problems.includes(name))
