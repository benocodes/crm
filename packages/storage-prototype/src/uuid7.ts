/** RFC9562: random within a millisecond; no monotonic ordering guarantee. */
export function uuid7(time = Date.now(), entropy?: Uint8Array): string {
  if (!Number.isSafeInteger(time) || time < 0 || time >= 2 ** 48)
    throw new RangeError('invalid UUIDv7 milliseconds')
  if (entropy && entropy.length !== 16) throw new RangeError('requires 16 entropy bytes')
  const b = entropy ? Uint8Array.from(entropy) : crypto.getRandomValues(new Uint8Array(16))
  let t = BigInt(time)
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(t & 255n)
    t >>= 8n
  }
  b[6] = (b[6] & 15) | 112
  b[8] = (b[8] & 63) | 128
  const s = Buffer.from(b).toString('hex')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}
