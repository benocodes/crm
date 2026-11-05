// The Gmail group of `setup:remote` ([[OPS150]], [[OPS65]] D41, [[CHN5]]'s Configuration table): an allow-listed, optional pass-through from the
// instance's own env file (the Clerk keys' file, D34), with `--auth none` as well. Secrets go to the Worker by `wrangler secret bulk`, vars into the
// env's `vars` block. Shapes are checked before any command. Nothing here ever puts a value in a message: refusals name the variable.
import { parseEnv } from 'node:util'
import { RemoteRefusal } from '../remote.js'
import type { EnvFileProbe, SetupOptions } from './types.js'

/** Put on the Worker as secrets. `CREDENTIALS_KEY` is never replaced once present ([[CHN5]] D4 owns rotation). */
export const GMAIL_SECRET_NAMES = ['GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY'] as const
/** Written into `env.<name>.vars` of the committed `wrangler.jsonc`: public values only. */
export const GMAIL_VAR_NAMES = [
  'GOOGLE_CLIENT_ID',
  'GMAIL_TOPIC_NAME',
  'GMAIL_PUSH_SUBSCRIPTION',
  'GMAIL_PUSH_SERVICE_ACCOUNT',
  'PUBLIC_BASE_URL',
  'CONNECT_RETURN_URL',
  'CREDENTIALS_KEY_VERSION',
  'GMAIL_BACKFILL_DAYS',
  'ATTACHMENT_MAX_BYTES',
] as const
/** [[CHN5]] D58's four names: none → the group is skipped, some → refused, all → on. */
export const GMAIL_CORE_NAMES = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY'] as const
/** Never replaced, even with `--rotate-secrets`: stored credentials are encrypted under it. */
export const NEVER_REPLACED = 'CREDENTIALS_KEY'

export interface Gmail {
  /** Secret values by name (stdin of `secret bulk` only). */
  secrets: Record<string, string>
  /** Var values by name, `PUBLIC_BASE_URL` defaulted. */
  vars: Record<string, string>
  /** The file as shown to the owner. */
  file: string
}

const positiveInt = (v: string) => /^[1-9]\d{0,15}$/.test(v)
const httpsUrl = (v: string) => {
  try {
    return new URL(v).protocol === 'https:'
  } catch {
    return false
  }
}
const RULES: Record<string, [(v: string) => boolean, string]> = {
  CREDENTIALS_KEY: [(v) => /^[A-Za-z0-9+/_-]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32, 'must be base64 that decodes to exactly 32 bytes'],
  CREDENTIALS_KEY_VERSION: [positiveInt, 'must be a positive integer'],
  GMAIL_BACKFILL_DAYS: [positiveInt, 'must be a positive integer'],
  ATTACHMENT_MAX_BYTES: [positiveInt, 'must be a positive integer'],
  PUBLIC_BASE_URL: [httpsUrl, 'must be an absolute https URL'],
  CONNECT_RETURN_URL: [httpsUrl, 'must be an absolute https URL'],
  GMAIL_TOPIC_NAME: [(v) => /^projects\/[^/\s]+\/topics\/[^/\s]+$/.test(v), 'must look like projects/<project>/topics/<topic>'],
  GMAIL_PUSH_SUBSCRIPTION: [(v) => /^projects\/[^/\s]+\/subscriptions\/[^/\s]+$/.test(v), 'must look like projects/<project>/subscriptions/<subscription>'],
  GMAIL_PUSH_SERVICE_ACCOUNT: [(v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'must be an email address'],
}

/**
 * The group from the probed env file, or `null` when it is skipped (no file on `--auth none`, or none of the four core names).
 * Throws `RemoteRefusal` before any request: the root `.env` and a file git does not ignore are refused as on `--auth clerk`.
 */
export function loadGmail(opts: SetupOptions, probe: EnvFileProbe): Gmail | null {
  const f = probe.display
  if (probe.status === 'root-env') throw new RemoteRefusal(`env file ${f} is the root .env, which holds another instance's values: use the instance's own file (.env.${opts.env} by default)`)
  if (probe.status === 'not-ignored') throw new RemoteRefusal(`env file ${f} is not ignored by git: add it to .gitignore before it holds a secret`)
  if (probe.status === 'missing') return null
  const parsed = parseEnv(probe.text ?? '')
  const value = (name: string): string | undefined => parsed[name]?.trim() || undefined
  const present = GMAIL_CORE_NAMES.filter((n) => value(n) !== undefined)
  if (present.length === 0) return null
  if (present.length < GMAIL_CORE_NAMES.length) {
    const missing = GMAIL_CORE_NAMES.filter((n) => !present.includes(n))
    throw new RemoteRefusal(`${f} has part of the Gmail group but is missing ${missing.join(', ')}: the four core values go together, all or none ([[CHN5]] D58)`)
  }
  const secrets: Record<string, string> = {}
  const vars: Record<string, string> = {}
  for (const name of [...GMAIL_SECRET_NAMES, ...GMAIL_VAR_NAMES]) {
    const v = value(name)
    if (v === undefined) continue
    const rule = RULES[name]
    if (rule && !rule[0](v)) throw new RemoteRefusal(`${name} in ${f} ${rule[1]}`)
    ;(GMAIL_SECRET_NAMES as readonly string[]).includes(name) ? (secrets[name] = v) : (vars[name] = v)
  }
  vars.PUBLIC_BASE_URL ??= `https://${opts.apiHost}`
  return { secrets, vars, file: f }
}

/** A config diff line with the value of any Gmail var hidden: output names variables, never values. */
export function hideGmailValues(line: string): string {
  let out = line
  for (const name of GMAIL_VAR_NAMES) out = out.replace(new RegExp(`("${name}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,}\\s]+)`, 'g'), '$1<value hidden>')
  return out
}
