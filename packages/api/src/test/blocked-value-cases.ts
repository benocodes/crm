// Test-only. ONE table of blocked-sender values ([[CHN406]] D7, [[CHN409]] P2, [[CHN410]] P4): `blocked_senders.create` and `connections.update`'s `blocked_senders`
// must give the same accept or refuse answer for each, so both suites read this table instead of copying it.
const label = (c: string, n: number) => c.repeat(n)
const LONG_DOMAIN = `${label('a', 63)}.${label('b', 63)}.${label('c', 63)}.${label('d', 58)}.com` // 254 characters

/** [kind, input, the stored value, or null when the value is refused]. */
export const VALUE_CASES: ReadonlyArray<readonly ['address' | 'domain', string, string | null]> = [
  ['address', 'Foo@Example.COM ', 'foo@example.com'],
  ['address', 'foo', null],
  ['address', '   ', null],
  ['domain', 'Example.COM', 'example.com'],
  ['domain', '@example.com', null],
  ['domain', '.example.com', null],
  ['domain', 'example.com.', null],
  ['domain', 'localhost', null],
  ['domain', LONG_DOMAIN, null],
  ['domain', 'xn--80ak6aa92e.xn--p1ai', 'xn--80ak6aa92e.xn--p1ai'],
]
