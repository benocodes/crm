// The Playwright E2E reads Clerk keys from the gitignored `.env.dev` only ([[UI30]] E2E, [[OPS65]] D34's rule): parsed on its own, never loaded into
// `process.env`, development keys only. A refusal names the file or the key kind and never a value.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseEnv } from 'node:util'
import { publishableKeyHost } from '@vault/api'

export interface DevClerkEnv {
  secretKey: string
  publishableKey: string
  /** `https://<frontend api host>` */
  issuer: string
}

export function loadDevClerkEnv(path: string): DevClerkEnv {
  if (basename(path) !== '.env.dev') throw new Error('the E2E reads Clerk keys from .env.dev only (never the root .env or an .env.hq* file)')
  const vars = parseEnv(readFileSync(path, 'utf8'))
  const secretKey = vars.CLERK_SECRET_KEY?.trim()
  const publishableKey = (vars.CLERK_PUBLISHABLE_KEY || vars.VITE_CLERK_PUBLISHABLE_KEY)?.trim()
  if (!secretKey) throw new Error('.env.dev has no CLERK_SECRET_KEY')
  if (!publishableKey) throw new Error('.env.dev has no CLERK_PUBLISHABLE_KEY (or VITE_CLERK_PUBLISHABLE_KEY)')
  if (!secretKey.startsWith('sk_test_')) throw new Error('.env.dev: CLERK_SECRET_KEY is not a development key (sk_test_): the E2E never uses a live instance')
  if (!publishableKey.startsWith('pk_test_')) throw new Error('.env.dev: the publishable key is not a development key (pk_test_): the E2E never uses a live instance')
  const host = publishableKeyHost(publishableKey)
  if (!host) throw new Error('.env.dev: the publishable key does not carry a Frontend API host')
  return { secretKey, publishableKey, issuer: `https://${host}` }
}
