import { betterAuth } from 'better-auth'
import { describe, expect, it } from 'vitest'
import { originMatches } from '@vibase/api/origins'
import { ORIGIN_MATCH_TABLE } from '@vibase/api/test/origin-table'
import { authOptions } from './auth.js'

// [[API622]] D1/D3 (group 2, parity): the vault's `originMatches` and Better Auth's own `trustedOrigins` matcher answer alike on the same table. `matchesOriginPattern` is not exported, so it is reached through the public
// context's `isTrustedOrigin`, which applies it over the configured `trustedOrigins` (the first test proves that premise).
const db = { prepare: () => ({}) }
const baseURL = 'https://api.example.com'
const trustedBy = async (entries: string[], origin: string) => {
  const auth = betterAuth(
    authOptions(db, { secret: 'a-valid-auth-secret-of-exactly-32!', baseURL, trustedOrigins: entries }),
  )
  return (await auth.$context).isTrustedOrigin(origin)
}

describe('originMatches agrees with Better Auth', () => {
  it('premise: isTrustedOrigin applies the configured entries (the base URL is always trusted, an unlisted origin is not)', async () => {
    expect(await trustedBy([], baseURL)).toBe(true)
    expect(await trustedBy([], 'https://other.example.com')).toBe(false)
    expect(await trustedBy(['https://*.hq.vibase.ai'], 'https://a.hq.vibase.ai')).toBe(true)
  })
  it.each(ORIGIN_MATCH_TABLE)('%s vs %s -> %s in both', async (entry, origin, want) => {
    expect(originMatches([entry], origin)).toBe(want)
    expect(await trustedBy([entry], origin)).toBe(want)
  })
})

// P3: the rows where the two differ are all in the REQUEST origin, never in an entry shape (the grammar refuses `:443` and upper-case entries, so no accepted entry can cause one). Better Auth normalises the URL it is given;
// `originMatches` compares the origin as the browser sent it (always lower-case, no default port, a non-empty label), so it is stricter: it refuses where Better Auth would pass. Pinned so a change in either shows.
describe('known differences (request origins a browser never sends)', () => {
  it.each(['https://A.HQ.vibase.ai', 'https://.hq.vibase.ai'])(
    '%s: Better Auth trusts it, originMatches does not',
    async (origin) => {
      expect(await trustedBy(['https://*.hq.vibase.ai'], origin)).toBe(true)
      expect(originMatches(['https://*.hq.vibase.ai'], origin)).toBe(false)
    },
  )
})
