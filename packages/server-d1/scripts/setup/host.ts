// The host rules of both setup front-ends ([[OPS308]], [[OPS249]] D12, D14): `--workers-dev` and its account subdomain, the record's host mode, the host change an instance
// may make only with `--change-host`, and the lines that say what a move breaks. Pure but for the injected `fetch`: no subprocess, no file.
import { CALLBACK_PATH } from '@vibase/api'
import { RemoteRefusal } from '../remote.js'
import type { Credentials, SetupOptions } from './types.js'

export const WORKERS_DEV_SUFFIX = '.workers.dev'
export const isWorkersDevHost = (host: string): boolean => host.toLowerCase().endsWith(WORKERS_DEV_SUFFIX)
/** One DNS label, lower case: what a workers.dev subdomain is. */
export const SUBDOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** What an instance's record says about its host: the host when it is recorded, and whether `workers_dev` is on. */
export interface RecordedHost {
  apiHost?: string
  workersDev: boolean
}
export type HostMode = 'workers-dev' | 'custom'
/** A recorded host under `workers.dev` is workers.dev mode; one elsewhere is a custom domain (also after a move, which keeps `workers_dev` on); with no host, the flag decides. */
export const recordedMode = (r: RecordedHost): HostMode => (r.apiHost !== undefined ? (isWorkersDevHost(r.apiHost) ? 'workers-dev' : 'custom') : r.workersDev ? 'workers-dev' : 'custom')

/** [[CORE243]] D23: what a changed issuer breaks. Shared by the refusal, the config step's lines and the closing output. */
export const HOST_CHANGE_CONSEQUENCES = [
  'every session, session token and issued token is refused on the new host: people sign in again',
  'run `vibase login` again on each machine',
  'reconnect MCP clients to the new URL',
]
export const hostChangeRefusal = (flag: string, why: string): string =>
  `${flag}: ${why}. Changing the host changes the issuer, which logs everyone out: ${HOST_CHANGE_CONSEQUENCES.join('; ')}. Add --change-host to do it on purpose`

/** The consequence lines of an accepted move, with the new Google redirect URI when Google sign-in is on. */
export function moveLines(from: string | undefined, to: string, google: boolean, gmail = false): string[] {
  return [
    `host change: ${from ?? 'workers.dev'} -> ${to}`,
    ...HOST_CHANGE_CONSEQUENCES.map((c) => `consequence: ${c}`),
    ...(google ? [`consequence: add the redirect URI https://${to}/auth/callback/google to the Google sign-in OAuth client (the old one stops working)`] : []),
    ...(gmail ? [`consequence: add the redirect URI https://${to}${CALLBACK_PATH} to the Google OAuth client of the Gmail connection (the old one stops working)`] : []),
  ]
}

/** The manual line of a move that leaves an old custom domain behind: setup makes no DNS or custom-domain delete call. */
export const oldDomainManual = (host: string): string => `${host} may still be attached to the Worker as a custom domain: remove it in the dashboard (Workers & Pages > the Worker > Settings > Domains & Routes); setup makes no DNS or custom-domain delete call`

const CF = 'https://api.cloudflare.com/client/v4/'
const subdomainUrl = (c: Credentials) => `${CF}accounts/${c.accountId}/workers/subdomain`
const DASHBOARD = 'Workers & Pages > Overview > Account details > Subdomain (dash.cloudflare.com)'

type Read = { kind: 'present'; subdomain: string } | { kind: 'none' }
async function readSubdomain(creds: Credentials, f: typeof fetch): Promise<Read> {
  const res = await f(subdomainUrl(creds), { headers: { authorization: `Bearer ${creds.apiToken}` } })
  // Cloudflare's reference does not document the answer for an account with no subdomain; a 404 is what it gives (UNCONFIRMED, see OPS308's RESULT.md).
  if (res.status === 404) return { kind: 'none' }
  if (!res.ok) throw new RemoteRefusal(`Workers Scripts Read: the token cannot read the account's workers.dev subdomain (HTTP ${res.status})`)
  const sub = ((await res.json()) as { result?: { subdomain?: unknown } | null }).result?.subdomain
  return typeof sub === 'string' && sub !== '' ? { kind: 'present', subdomain: sub } : { kind: 'none' }
}
async function putSubdomain(creds: Credentials, f: typeof fetch, name: string): Promise<void> {
  const res = await f(subdomainUrl(creds), { method: 'PUT', headers: { authorization: `Bearer ${creds.apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ subdomain: name }) })
  if (!res.ok) throw new RemoteRefusal(`Workers Scripts Edit: registering the workers.dev subdomain ${name} failed (HTTP ${res.status})`)
}

/**
 * P1, P3: the one host of this run, resolved before any write. A custom host is the flag; a workers.dev host is derived from the account subdomain (read here, also on a dry run) and the
 * worker name, which the caller has already taken from the record. Registration (`--register-workers-subdomain`) is the only write and never happens on a dry run. A host that differs from
 * the record (a renamed subdomain, a move) is refused without `--change-host`. Returns the options with `apiHost`, `move` and `hostNotes` set.
 */
export async function resolveHost(opts: SetupOptions, creds: Credentials, f: typeof fetch): Promise<SetupOptions> {
  let host = opts.apiHost
  let pending: string | undefined
  const notes: string[] = []
  if (opts.workersDev) {
    const read = await readSubdomain(creds, f)
    let subdomain: string
    if (read.kind === 'present') {
      if (opts.registerSubdomain !== undefined && opts.registerSubdomain !== read.subdomain) {
        throw new RemoteRefusal(`--register-workers-subdomain ${opts.registerSubdomain}: this account already has the workers.dev subdomain ${read.subdomain}; setup never renames an account subdomain (drop the flag)`)
      }
      subdomain = read.subdomain
    } else if (opts.registerSubdomain === undefined) {
      throw new RemoteRefusal(`this account has no workers.dev subdomain: register one in the dashboard (${DASHBOARD}), or pass --register-workers-subdomain <name> once (an account-wide, one-time choice)`)
    } else {
      // No write here: the host is derived from the planned name and the PUT waits (`registerPending`) until every refusal and the preflight have passed.
      subdomain = opts.registerSubdomain
      pending = subdomain
      notes.push(opts.dryRun ? `would register the workers.dev subdomain ${subdomain} (--register-workers-subdomain; a dry run registers nothing)` : `will register the workers.dev subdomain ${subdomain} once every check and the preflight have passed (--register-workers-subdomain)`)
    }
    host = `${opts.workerName}.${subdomain}${WORKERS_DEV_SUFFIX}`
  }
  const rec = opts.recordedHost
  const mode: HostMode = opts.workersDev ? 'workers-dev' : 'custom'
  const changed = rec !== undefined && (recordedMode(rec) !== mode || (rec.apiHost !== undefined && rec.apiHost !== host))
  if (changed && !opts.changeHost) {
    throw new RemoteRefusal(hostChangeRefusal(opts.workersDev ? '--workers-dev' : `--api-host ${host}`, `this instance is recorded on ${rec!.apiHost ?? 'workers.dev'}, not ${host}`))
  }
  return { ...opts, apiHost: host, hostNotes: notes, ...(pending !== undefined && !opts.dryRun ? { pendingSubdomain: pending } : {}), ...(changed ? { move: { from: rec!.apiHost, fromMode: recordedMode(rec!) } } : {}) }
}

/**
 * The one write of host resolution: the PUT of `--register-workers-subdomain`, made by the caller after every refusal and after the preflight passed, never on a dry run.
 * Returns the line to print, or `null` when nothing was pending. Throws `RemoteRefusal` when Cloudflare refuses it.
 */
export async function registerPending(opts: SetupOptions, creds: Credentials, f: typeof fetch): Promise<string | null> {
  if (opts.pendingSubdomain === undefined || opts.dryRun) return null
  await putSubdomain(creds, f, opts.pendingSubdomain)
  return `registered the workers.dev subdomain ${opts.pendingSubdomain}`
}
