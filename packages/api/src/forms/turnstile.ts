import type { TurnstileVerdict, TurnstileVerifier } from './ingress.js'

// [[CHN432]] D6, P3a, P3b (432.4, 432.5): the `fetch` implementation of [[CHN429]]'s `TurnstileVerifier` port, against Cloudflare's `siteverify`.

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
export const SITEVERIFY_TIMEOUT_MS = 5000

/** Error codes that mean the check could not be made (our secret, or Cloudflare), not that the visitor failed it. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'internal-error',
])

export interface SiteverifyOptions {
  /** `TURNSTILE_SECRET_KEY`; missing or empty answers `unavailable` without a request. */
  secret: string | undefined
  /** The Worker's `fetch` (default); tests fake it. */
  fetch?: typeof fetch
  /** Default 5 s; one attempt, no retry. */
  timeoutMs?: number
}

const unavailable: TurnstileVerdict = { outcome: 'unavailable' }
const rejected: TurnstileVerdict = { outcome: 'rejected' }

/**
 * Never throws and never logs: the secret and the token appear in the request only. `passed` only for `success: true` with a string `hostname` (the
 * handler compares it with the origin's host); `unavailable` for anything that says the check could not be made; `rejected` for everything else.
 */
export function siteverifyVerifier(options: SiteverifyOptions): TurnstileVerifier {
  const { secret, timeoutMs = SITEVERIFY_TIMEOUT_MS } = options
  return {
    async verify({ token, ip }) {
      if (secret === undefined || secret === '') return unavailable
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const body = new URLSearchParams({ secret, response: token })
        if (ip) body.set('remoteip', ip)
        const call = (options.fetch ?? fetch)(SITEVERIFY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: controller.signal,
        })
        const timeout = new Promise<never>((_, fail) => {
          timer = setTimeout(() => {
            controller.abort()
            fail(new Error('siteverify timed out'))
          }, timeoutMs)
        })
        const response = await Promise.race([call, timeout])
        if (!response.ok) return unavailable
        const parsed: unknown = await Promise.race([response.json(), timeout])
        if (typeof parsed !== 'object' || parsed === null) return unavailable
        const answer = parsed as { success?: unknown; hostname?: unknown; 'error-codes'?: unknown }
        const codes = Array.isArray(answer['error-codes']) ? answer['error-codes'] : []
        if (codes.some((c) => typeof c === 'string' && UNAVAILABLE_CODES.has(c))) return unavailable
        if (answer.success === true && typeof answer.hostname === 'string')
          return { outcome: 'passed', hostname: answer.hostname }
        return rejected
      } catch {
        return unavailable
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
