// One Google signing-key cache ([[CORE577]] D21, P6), shared by `POST /inbound/gmail` and the connect callback's ID-token check. Per isolate: the composition builds one and hands it to every app it builds;
// `createApp` builds its own when it is given none (tests, the Node server).
//
// The rules, per JWKS URL: the keys of a successful fetch are used for 5 minutes. A fetch is ATTEMPTED when there are no keys, they are older than 5 minutes, or the token's `kid` is not among them, but at most
// once a minute, success or failure (every attempt stamps the minute), so neither a flood of forged key ids nor a down Google becomes a flood of fetches. A failed attempt leaves no usable keys (a stale set is
// never served past its 5 minutes). Concurrent callers share the one attempt in flight. The clock and the `fetch` are injected, so a test owns both.
import { createLocalJWKSet } from 'jose'

/** How long the keys of one successful fetch are used. */
export const KEY_REUSE_MS = 5 * 60_000
/** The least time between two fetch attempts for one URL, success or failure. */
export const KEY_ATTEMPT_MS = 60_000

export type GoogleKeys = ReturnType<typeof createLocalJWKSet>

export interface GoogleKeyCache {
  /**
   * The keys to verify a token whose protected header names `kid`, fetched from `url` when the rules above call for it. `null`: no usable keys (the fetch failed, or is not allowed yet and nothing fresh is held).
   * A set that does not hold `kid` still comes back when a fetch is not allowed: verification then fails on its own, which is the answer for an unknown key id.
   */
  keysFor(url: string, kid: string | undefined): Promise<GoogleKeys | null>
}

interface Entry {
  keys?: GoogleKeys
  kids: Set<string>
  filledAt: number
  lastAttempt: number
  inflight?: Promise<void>
}

export function createGoogleKeyCache(deps: { fetch: typeof fetch; now: () => Date }): GoogleKeyCache {
  const entries = new Map<string, Entry>()
  const entryFor = (url: string): Entry => {
    let e = entries.get(url)
    if (!e) {
      e = { kids: new Set(), filledAt: 0, lastAttempt: Number.NEGATIVE_INFINITY }
      entries.set(url, e)
    }
    return e
  }

  async function attempt(url: string, e: Entry, at: number): Promise<void> {
    e.lastAttempt = at
    e.inflight = (async () => {
      try {
        const res = await deps.fetch(url)
        if (!res.ok) throw new Error('jwks status')
        const body = (await res.json()) as { keys?: unknown }
        if (!Array.isArray(body.keys)) throw new Error('jwks shape')
        e.keys = createLocalJWKSet(body as Parameters<typeof createLocalJWKSet>[0])
        e.kids = new Set(
          body.keys.map((k) => (k as { kid?: unknown }).kid).filter((k): k is string => typeof k === 'string'),
        )
        e.filledAt = at
      } catch {
        e.keys = undefined
        e.kids = new Set()
      } finally {
        e.inflight = undefined
      }
    })()
    await e.inflight
  }

  return {
    async keysFor(url, kid) {
      const e = entryFor(url)
      // Whoever arrives while an attempt is in flight shares its outcome.
      if (e.inflight) {
        await e.inflight
        return e.keys ?? null
      }
      const at = deps.now().getTime()
      const fresh = (): boolean => e.keys !== undefined && at - e.filledAt < KEY_REUSE_MS
      const wanted = !fresh() || (kid !== undefined && !e.kids.has(kid))
      if (wanted && at - e.lastAttempt >= KEY_ATTEMPT_MS) await attempt(url, e, at)
      return fresh() ? (e.keys ?? null) : null
    },
  }
}
