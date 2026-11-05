// The Clerk credentials of one instance ([[OPS65]] D14, D34, D35, D36): read from the instance's own gitignored env file, parsed on its
// own (never loaded into `process.env`, never read from it), with the kind and issuer derived from the key shapes. Nothing here prints a value.
import { createPublicKey } from 'node:crypto'
import { parseEnv } from 'node:util'
import { publishableKeyHost } from '@vault/api'
import { RemoteRefusal } from '../remote.js'
import type { EnvFileProbe, SetupDeps, SetupOptions } from './types.js'

export interface ClerkKeys {
  secretKey: string
  publishableKey: string
  kind: 'development' | 'production'
  /** `https://<frontend api host>`, decoded from the publishable key. */
  issuer: string
  /** The env file as shown to the owner. */
  file: string
}

const kindOf = (key: string, prefix: 'sk' | 'pk'): ClerkKeys['kind'] | null => (key.startsWith(`${prefix}_test_`) && key.length > 8 ? 'development' : key.startsWith(`${prefix}_live_`) && key.length > 8 ? 'production' : null)

/** `pk_<kind>_<base64(host$)>`: the issuer is that host over https. The decoder is shared with the Worker ([[UI30]] D5). */
export function decodePublishableKey(pk: string): string {
  const host = publishableKeyHost(pk)
  if (host === undefined) throw new RemoteRefusal('the Clerk publishable key is malformed: it does not carry a Frontend API host')
  return `https://${host}`
}

/** An RSA JWK of the instance's JWKS as the SPKI PEM that `CLERK_JWT_KEY` holds. */
export function pemFromJwk(jwk: unknown): string {
  return createPublicKey({ key: jwk as never, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString()
}

/** Throws `RemoteRefusal` before any request: every refusal names the file or the flag, never a value. */
export function loadClerkKeys(opts: SetupOptions, deps: SetupDeps, taken?: EnvFileProbe): ClerkKeys {
  const probe = taken ?? deps.probeEnvFile(opts.clerkEnvFile, opts.env)
  const f = probe.display
  if (probe.status === 'root-env') throw new RemoteRefusal(`--clerk-env-file ${f} is the root .env, which holds another instance's keys: use the instance's own file (.env.${opts.env} by default)`)
  if (probe.status === 'missing') throw new RemoteRefusal(`Clerk env file ${f} not found: create it (gitignored) with CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY, or point --clerk-env-file at one`)
  if (probe.status === 'not-ignored') throw new RemoteRefusal(`Clerk env file ${f} is not ignored by git: add it to .gitignore before it holds a secret key`)
  const vars = parseEnv(probe.text ?? '')
  const secretKey = vars.CLERK_SECRET_KEY?.trim()
  if (!secretKey) throw new RemoteRefusal(`${f} has no CLERK_SECRET_KEY`)
  const fromFile = (vars.CLERK_PUBLISHABLE_KEY || vars.VITE_CLERK_PUBLISHABLE_KEY)?.trim()
  const flag = opts.clerkPublishableKey?.trim()
  if (flag && fromFile && flag !== fromFile) throw new RemoteRefusal(`--clerk-publishable-key differs from the publishable key in ${f}: drop the flag or fix the file`)
  const publishableKey = flag || fromFile
  if (!publishableKey) throw new RemoteRefusal(`${f} has no publishable key (CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY); --clerk-publishable-key can supply it`)
  const sk = kindOf(secretKey, 'sk')
  const pk = kindOf(publishableKey, 'pk')
  if (!sk) throw new RemoteRefusal(`CLERK_SECRET_KEY in ${f} is neither sk_test_… nor sk_live_…`)
  if (!pk) throw new RemoteRefusal(`the Clerk publishable key is neither pk_test_… nor pk_live_…`)
  if (sk !== pk) throw new RemoteRefusal(`the secret key (${sk}) and the publishable key (${pk}) are of different kinds: they are from different Clerk instances`)
  if (sk === 'production' && !opts.clerkProduction) throw new RemoteRefusal(`${f} holds a production Clerk key: pass --clerk-production to say so (every run, dry runs included)`)
  if (sk === 'development' && opts.clerkProduction) throw new RemoteRefusal(`--clerk-production with a development Clerk key (${f}): the flag must state the truth`)
  return { secretKey, publishableKey, kind: sk, issuer: decodePublishableKey(publishableKey), file: f }
}
