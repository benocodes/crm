import type { AuthEnv } from './adapter.js'

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

/**
 * The Frontend API host a Clerk publishable key carries (`pk_<test|live>_<base64(host$)>`), or `undefined` when the key has
 * another shape. Pure and platform-neutral (`atob`, no Node `Buffer`): the Worker and the setup command share it ([[UI30]] D5, [[OPS87]]).
 */
export function publishableKeyHost(pk: string): string | undefined {
  const m = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(pk)
  if (!m) return undefined
  let host: string
  try {
    host = atob(m[1]!.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return undefined
  }
  if (!host.endsWith('$')) return undefined
  const h = host.slice(0, -1)
  return HOST.test(h) ? h : undefined
}

/**
 * `CLERK_PUBLISHABLE_KEY` ([[UI30]] D5): public, returned by discovery for the connect page. Unset or blank is `undefined`. A key whose
 * Frontend API host is not `CLERK_ISSUER`'s host is a configuration error (a key pasted from another instance); every message names the
 * variable and never its value. Call it only with a provider configured.
 */
export function parsePublishableKey(env: AuthEnv): string | undefined {
  const key = env.CLERK_PUBLISHABLE_KEY?.trim()
  if (!key) return undefined
  const host = publishableKeyHost(key)
  if (host === undefined) throw new Error('CLERK_PUBLISHABLE_KEY is malformed: it does not carry a Frontend API host')
  let issuerHost: string
  try {
    issuerHost = new URL(env.CLERK_ISSUER ?? '').host
  } catch {
    throw new Error('CLERK_PUBLISHABLE_KEY cannot be checked: CLERK_ISSUER is not a URL')
  }
  if (host.toLowerCase() !== issuerHost.toLowerCase()) throw new Error('CLERK_PUBLISHABLE_KEY belongs to another Clerk instance than CLERK_ISSUER')
  return key
}
