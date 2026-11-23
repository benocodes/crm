// The Gmail group of `setup:remote` ([[OPS150]], [[OPS65]] D41, [[CHN5]]'s Configuration table): an allow-listed, optional pass-through from the
// instance's own env file (the Clerk keys' file, D34), with `--auth none` as well. Secrets go to the Worker by `wrangler secret bulk`, vars into the
// env's `vars` block. Shapes are checked before any command. Nothing here ever puts a value in a message: refusals name the variable.
import { parseEnv } from 'node:util'
import { PUSH_PATH, isValidPushVar, parseGmailConfig } from '@vibase/api'
import { RemoteRefusal } from '../remote.js'
import { googleClientIdProblem, looksLikeGoogleClientId } from './better-auth.js'
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
export const GMAIL_CORE_NAMES = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'OAUTH_STATE_SECRET',
  'CREDENTIALS_KEY',
] as const
/** [[OPS494]] D6: the header line when Gmail is off, in both setup front-ends. */
export const gmailOffLine = (file: string): string =>
  `gmail: off (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in ${file}): add them and re-run setup`
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

const httpsUrl = (v: string) => {
  try {
    return new URL(v).protocol === 'https:'
  } catch {
    return false
  }
}
/** `CREDENTIALS_KEY`, `CREDENTIALS_KEY_VERSION`, `GMAIL_BACKFILL_DAYS` and `ATTACHMENT_MAX_BYTES` are judged by the Worker's own parser (`parseGmailConfig`), so setup can never accept what the Worker rejects. */
const WORKER_RULES: Record<string, string> = {
  CREDENTIALS_KEY:
    'must be standard-alphabet, padded base64 that decodes to exactly 32 bytes (what the Worker accepts)',
  CREDENTIALS_KEY_VERSION: 'must be a positive integer of at most 9 digits (what the Worker accepts)',
  GMAIL_BACKFILL_DAYS: 'must be a positive integer of at most 9 digits (what the Worker accepts)',
  ATTACHMENT_MAX_BYTES: 'must be a positive integer of at most 9 digits (what the Worker accepts)',
}
const RULES: Record<string, [(v: string) => boolean, string]> = {
  // https for a remote deployment (the Worker also accepts http://localhost, which means nothing on Cloudflare), and the origin only: the push audience is `<base>${PUSH_PATH}`.
  PUBLIC_BASE_URL: [
    (v) => httpsUrl(v) && isValidPushVar('PUBLIC_BASE_URL', v),
    `must be an absolute https URL with no path (the endpoint is <it>${PUSH_PATH})`,
  ],
  CONNECT_RETURN_URL: [httpsUrl, 'must be an absolute https URL'],
  // The four push values are judged by the Worker's own rule (`isValidPushVar`, [[CHN5]] D87), so setup can never accept what the Worker rejects.
  GMAIL_TOPIC_NAME: [(v) => isValidPushVar('GMAIL_TOPIC_NAME', v), 'must look like projects/<project>/topics/<topic>'],
  GMAIL_PUSH_SUBSCRIPTION: [
    (v) => isValidPushVar('GMAIL_PUSH_SUBSCRIPTION', v),
    'must look like projects/<project>/subscriptions/<subscription>',
  ],
  GMAIL_PUSH_SERVICE_ACCOUNT: [(v) => isValidPushVar('GMAIL_PUSH_SERVICE_ACCOUNT', v), 'must be an email address'],
}

/**
 * The group from the probed env file, or `null` when it is skipped (no file on `--auth none`, or neither Google client value, [[OPS494]] D6).
 * Throws `RemoteRefusal` before any request: the root `.env` and a file git does not ignore are refused as on `--auth clerk`.
 */
export function loadGmail(opts: SetupOptions, probe: EnvFileProbe): Gmail | null {
  const f = probe.display
  if (probe.status === 'root-env')
    throw new RemoteRefusal(
      `env file ${f} is the root .env, which holds another instance's values: use the instance's own file (.env.${opts.env} by default)`,
    )
  if (probe.status === 'not-ignored')
    throw new RemoteRefusal(`env file ${f} is not ignored by git: add it to .gitignore before it holds a secret`)
  if (probe.status === 'missing') return null
  const parsed = parseEnv(probe.text ?? '')
  const value = (name: string): string | undefined => parsed[name]?.trim() || undefined
  const present = GMAIL_CORE_NAMES.filter((n) => value(n) !== undefined)
  // [[OPS494]] D6: the Google client turns Gmail on; without either half the group is off whatever else of it the file holds (`vibase-server init` writes the generated keys first).
  if (value('GOOGLE_CLIENT_ID') === undefined && value('GOOGLE_CLIENT_SECRET') === undefined) return null
  if (present.length < GMAIL_CORE_NAMES.length) {
    const missing = GMAIL_CORE_NAMES.filter((n) => !present.includes(n))
    throw new RemoteRefusal(
      `${f} has part of the Gmail group but is missing ${missing.join(', ')}: the four core values go together, all or none ([[CHN5]] D58)`,
    )
  }
  // [[GH442]] item 3: the same pair check as the Google sign-in client, for the Gmail client.
  const idProblem = googleClientIdProblem('GOOGLE_CLIENT_ID', value('GOOGLE_CLIENT_ID')!, f)
  if (idProblem) throw new RemoteRefusal(idProblem)
  if (looksLikeGoogleClientId(value('GOOGLE_CLIENT_SECRET')!))
    throw new RemoteRefusal(
      `GOOGLE_CLIENT_SECRET in ${f} looks like a client ID: are GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET swapped?`,
    )
  const secrets: Record<string, string> = {}
  const vars: Record<string, string> = {}
  for (const name of [...GMAIL_SECRET_NAMES, ...GMAIL_VAR_NAMES]) {
    const v = value(name)
    if (v === undefined) continue
    const rule = RULES[name]
    if (rule && !rule[0](v)) throw new RemoteRefusal(`${name} in ${f} ${rule[1]}`)
    ;(GMAIL_SECRET_NAMES as readonly string[]).includes(name) ? (secrets[name] = v) : (vars[name] = v)
  }
  const { problems } = parseGmailConfig({ ...secrets, ...vars })
  const bad = problems.filter((n) => n in WORKER_RULES)
  if (bad.length > 0) throw new RemoteRefusal(bad.map((n) => `${n} in ${f} ${WORKER_RULES[n]}`).join('; '))
  // [[OPS249]] D2: on `better-auth` one base URL is the issuer, the Gmail push endpoint and the redirect origin, so the file may not name another.
  if (
    opts.auth === 'better-auth' &&
    vars.PUBLIC_BASE_URL !== undefined &&
    new URL(vars.PUBLIC_BASE_URL).origin !== `https://${opts.apiHost}`
  ) {
    throw new RemoteRefusal(
      `PUBLIC_BASE_URL in ${f} differs from https://${opts.apiHost}, the base URL of this run: on --auth better-auth they are one value (remove it from the file)`,
    )
  }
  vars.PUBLIC_BASE_URL ??= `https://${opts.apiHost}`
  return { secrets, vars, file: f }
}

/** A config diff line with the value of any Gmail var hidden: output names variables, never values. */
export function hideGmailValues(line: string): string {
  let out = line
  for (const name of GMAIL_VAR_NAMES)
    out = out.replace(new RegExp(`("${name}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,}\\s]+)`, 'g'), '$1<value hidden>')
  return out
}
