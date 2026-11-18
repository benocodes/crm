import type { TurnstileVerdict, TurnstileVerifier } from './ingress.js'

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
export const SITEVERIFY_TIMEOUT_MS = 5000

export interface SiteverifyOptions {
  secret: string | undefined
  fetch?: typeof fetch
  timeoutMs?: number
}

/** STUB (red commit): replaced by the real verifier. */
export function siteverifyVerifier(_options: SiteverifyOptions): TurnstileVerifier {
  return { verify: async (): Promise<TurnstileVerdict> => ({ outcome: 'unavailable' }) }
}
