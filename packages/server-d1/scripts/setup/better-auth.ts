// The Better Auth half of both setup front-ends ([[OPS249]]): the provider rule (D1), the inputs the instance's own file holds (D3, D4) and the state rules the secrets and
// bootstrap steps share. Pure: no subprocess, no file, no network. Nothing here prints a value: refusals name the variable or the file.
import { randomBytes } from 'node:crypto'
import { parseEnv } from 'node:util'
import { AUTH_SECRET_MIN_LENGTH } from '../../src/auth-config.js'
import { RemoteRefusal } from '../remote.js'
import type { RecordedHost } from './host.js'
import type { SetupOptions } from './types.js'

export const PROVIDERS = ['better-auth', 'clerk', 'none'] as const
export type AuthProvider = (typeof PROVIDERS)[number]

/** What an instance's record says about its provider: where it is recorded (a file path, or `wrangler.jsonc`) and the provider (absent `AUTH_PROVIDER` means `none`, [[OPS249]] D1). */
export interface RecordedAuth {
  provider: AuthProvider
  where: string
  /** The record's host ([[OPS308]]); absent for a lookup that has none. */
  host?: RecordedHost
}
/** Looks an instance up by `--env`: `null` is a new instance (no record). */
export type RecordLookup = (env: string) => RecordedAuth | null

/** The provider a recorded `vars` block runs: `AUTH_PROVIDER` absent or empty is `none` (the `smoked1` shape); any other unknown value is refused, naming it. */
export function providerFromVars(vars: unknown, where: string): AuthProvider {
  const v = typeof vars === 'object' && vars !== null ? (vars as Record<string, unknown>).AUTH_PROVIDER : undefined
  if (v === undefined || v === '' || v === 'none') return 'none'
  if (v === 'better-auth' || v === 'clerk') return v
  throw new RemoteRefusal(
    `${where} records AUTH_PROVIDER ${JSON.stringify(v)}, which setup does not know (better-auth, clerk or none)`,
  )
}

/**
 * D1: a recorded instance runs with its recorded provider and refuses a differing `--auth`; a new instance takes the flag, else `better-auth`.
 * The refusal names the recorded value and [[OPS250]], the migration that changes a provider.
 */
export function chooseProvider(flag: string | undefined, record: RecordedAuth | null): AuthProvider {
  if (record === null) return (flag as AuthProvider | undefined) ?? 'better-auth'
  if (flag !== undefined && flag !== record.provider) {
    throw new RemoteRefusal(
      `--auth ${flag}: this instance is recorded as ${record.provider} in ${record.where}; changing the provider is a migration (OPS250), not a setup re-run (drop the flag, or give --auth ${record.provider}; setup:remote --replace-instance <env> builds a fresh instance in its place)`,
    )
  }
  return record.provider
}

/** The Worker secrets of the optional Google sign-in client ([[CORE294]] D7): both or neither. */
export const GOOGLE_SECRET_NAMES = ['AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET'] as const

/** [[GH442]] item 3: every Google OAuth client ID ends in this. */
export const GOOGLE_CLIENT_ID_SUFFIX = '.apps.googleusercontent.com'
export const looksLikeGoogleClientId = (v: string): boolean => v.trim().endsWith(GOOGLE_CLIENT_ID_SUFFIX)
/** The refusal text for a client ID that is not one, or `null`. Names the variable and the file, never the value. */
export const googleClientIdProblem = (name: string, v: string, file: string): string | null =>
  looksLikeGoogleClientId(v)
    ? null
    : `${name} in ${file} does not end in ${GOOGLE_CLIENT_ID_SUFFIX}: it is not a Google OAuth client ID (are the client ID and the client secret swapped?)`

export interface BetterAuthInputs {
  /** The instance's own file as shown to the owner (`.env.<env>`, or the secrets file's path). */
  file: string
  /** `AUTH_SECRET` as the file holds it; absent means states (a) or (d) of [[OPS249]] D3. */
  authSecret?: string
  /** The Google pair's values, only when the file holds both ([[OPS249]] D4). */
  google?: Record<(typeof GOOGLE_SECRET_NAMES)[number], string>
}

/**
 * The Better Auth inputs of the instance's own file, judged before any step: an `AUTH_SECRET` the Worker would refuse (under 32 characters) and half a Google pair are refusals
 * that name the variable, never a value. `undefined` for any other provider.
 */
export function loadBetterAuth(
  opts: Pick<SetupOptions, 'auth'>,
  text: string | undefined,
  file: string,
): BetterAuthInputs | undefined {
  if (opts.auth !== 'better-auth') return undefined
  const parsed = parseEnv(text ?? '')
  const value = (name: string): string | undefined => parsed[name]?.trim() || undefined
  const out: BetterAuthInputs = { file }
  const secret = value('AUTH_SECRET')
  if (secret !== undefined) {
    if (secret.length < AUTH_SECRET_MIN_LENGTH)
      throw new RemoteRefusal(
        `AUTH_SECRET in ${file} is shorter than ${AUTH_SECRET_MIN_LENGTH} characters: the Worker refuses it (delete the line to have setup generate one)`,
      )
    out.authSecret = secret
  }
  const [id, key] = GOOGLE_SECRET_NAMES.map(value)
  if ((id === undefined) !== (key === undefined)) {
    throw new RemoteRefusal(
      `${file} has ${id === undefined ? 'AUTH_GOOGLE_CLIENT_SECRET' : 'AUTH_GOOGLE_CLIENT_ID'} but is missing ${id === undefined ? 'AUTH_GOOGLE_CLIENT_ID' : 'AUTH_GOOGLE_CLIENT_SECRET'}: the Google pair goes together, both or neither (CORE294 D7)`,
    )
  }
  // [[GH442]] item 3: a swapped pair deploys and then fails at Google with `invalid_client`; refuse it before any step, naming the variable, never the value.
  if (id !== undefined && key !== undefined) {
    const idProblem = googleClientIdProblem('AUTH_GOOGLE_CLIENT_ID', id, file)
    if (idProblem) throw new RemoteRefusal(idProblem)
    if (looksLikeGoogleClientId(key))
      throw new RemoteRefusal(
        `AUTH_GOOGLE_CLIENT_SECRET in ${file} looks like a client ID (it ends in ${GOOGLE_CLIENT_ID_SUFFIX}): are AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET swapped?`,
      )
  }
  if (id !== undefined && key !== undefined) out.google = { AUTH_GOOGLE_CLIENT_ID: id, AUTH_GOOGLE_CLIENT_SECRET: key }
  return out
}

/** 32 random bytes, base64url: 43 characters, inside the Worker's rule for `AUTH_SECRET` ([[CORE243]] D6). */
export const newAuthSecret = (): string => randomBytes(32).toString('base64url')

/** D3's four states: (a) neither file nor Worker has it, (b) the file only, (c) both, (d) the Worker only. */
export type AuthSecretState = 'a' | 'b' | 'c' | 'd'
export const authSecretState = (inFile: boolean, onWorker: boolean): AuthSecretState =>
  inFile ? (onWorker ? 'c' : 'b') : onWorker ? 'd' : 'a'

/** State (d)'s `manual` line: the Worker has a secret the operator does not hold, and nothing replaces it ([[OPS249]] D3). */
export const authSecretManual = (file: string): string =>
  `AUTH_SECRET is set on the Worker but not in ${file}: owner-reset needs it; copy it in if you have it`
