import { describe, expect, it } from 'vitest'
import { bytesOf } from '../../test/channels.js'
import { chunkedStream, toBase64Url } from '../../test/gmail.js'
import { base64UrlMemberDecoder } from './decoder.js'

// [[CHN5]] D25: one streaming decoder for `raw` and `data`. It skips to the top-level member and decodes chunk by chunk.
const enc = new TextEncoder()
const json = (members: Array<[string, unknown]>): Uint8Array => enc.encode(`{${members.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`)
const wrap = (body: Uint8Array, member = 'raw'): Uint8Array => json([['id', 'm1'], ['snippet', 'she said "raw":"AAAA" and \\"raw\\": ok'], ['labelIds', ['INBOX']], [member, toBase64Url(body)], ['sizeEstimate', 7]])

const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const k of chunks) c.enqueue(k)
      c.close()
    },
  })
const decode = async (chunks: Uint8Array[], member = 'raw'): Promise<Uint8Array> => new Uint8Array(await new Response(streamOf(chunks).pipeThrough(base64UrlMemberDecoder(member))).arrayBuffer())
const same = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b))

describe('base64UrlMemberDecoder', () => {
  it('decodes the member of a wire body in one chunk', async () => {
    const body = bytesOf(100)
    expect(same(await decode([wrap(body)]), body)).toBe(true)
  })

  it.each([0, 1, 2, 3, 4, 5, 7, 8, 9, 10])('every split point of a %i-byte body (padding and none, a quad cut anywhere, the member cut anywhere)', async (n) => {
    const body = bytesOf(n, 9)
    const wire = wrap(body)
    for (let i = 0; i <= wire.byteLength; i++) {
      expect(same(await decode([wire.slice(0, i), wire.slice(i)]), body), `split at ${i}`).toBe(true)
    }
  })

  it('every pair of split points of a small body, and one byte at a time', async () => {
    const body = bytesOf(5, 2)
    const wire = json([['a', 'x"raw":"'], ['raw', toBase64Url(body)]])
    for (let i = 0; i <= wire.byteLength; i++) for (let j = i; j <= wire.byteLength; j++) expect(same(await decode([wire.slice(0, i), wire.slice(i, j), wire.slice(j)]), body), `${i},${j}`).toBe(true)
    expect(same(await decode([...wire].map((b) => Uint8Array.of(b))), body)).toBe(true)
  })

  it('a raw-looking string and an escaped quote in an earlier member are not the member', async () => {
    const body = enc.encode('the real original')
    const wire = enc.encode(`{"snippet":"x \\"raw\\":\\"QUFB\\" y","note":"\\\\","raw":"${toBase64Url(body)}"}`)
    expect(new TextDecoder().decode(await decode([wire]))).toBe('the real original')
  })

  it('only a top-level member counts: a nested raw and an array element are skipped', async () => {
    const body = enc.encode('top')
    const wire = enc.encode(`{"payload":{"raw":"QUFB","x":["raw","raw"]},"raw":"${toBase64Url(body)}"}`)
    expect(new TextDecoder().decode(await decode([wire]))).toBe('top')
  })

  it('works for the attachment member `data`', async () => {
    const body = bytesOf(1000)
    expect(same(await decode([json([['size', 1000], ['data', toBase64Url(body)]])], 'data'), body)).toBe(true)
  })

  it('accepts padding and an empty value', async () => {
    expect(new TextDecoder().decode(await decode([enc.encode('{"raw":"aGk="}')]))).toBe('hi')
    expect((await decode([enc.encode('{"raw":""}')])).byteLength).toBe(0)
  })

  it('emits output before the input ends (chunk by chunk, not buffered)', async () => {
    const t = base64UrlMemberDecoder('raw')
    const writer = t.writable.getWriter()
    const reader = t.readable.getReader()
    const first = enc.encode(`{"raw":"${toBase64Url(bytesOf(3000))}`)
    void writer.write(first)
    const got = await Promise.race([reader.read(), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1000))])
    expect(got).not.toBe('timeout')
    expect((got as ReadableStreamReadResult<Uint8Array>).value!.byteLength).toBeGreaterThan(0)
    void writer.abort().catch(() => {})
  })

  it.each([
    ['a plus sign', '{"raw":"ab+d"}'],
    ['a slash', '{"raw":"ab/d"}'],
    ['a space', '{"raw":"ab d"}'],
    ['an escape', '{"raw":"ab\\u0041d"}'],
    ['one dangling character', '{"raw":"abcde"}'],
    ['data after padding', '{"raw":"aGk=aGk"}'],
  ])('invalid base64url errors the stream: %s', async (_name, text) => {
    await expect(decode([enc.encode(text)])).rejects.toThrow()
  })

  it('a missing member, a non-string member and a truncated body all error', async () => {
    await expect(decode([enc.encode('{"id":"x"}')])).rejects.toThrow()
    await expect(decode([enc.encode('{"raw":12}')])).rejects.toThrow()
    await expect(decode([enc.encode('{"raw":"QUJD')])).rejects.toThrow()
  })

  it('a 5 MiB + 123 byte original decodes byte-identical, in uneven chunks', async () => {
    const body = bytesOf(5 * 1024 * 1024 + 123, 4)
    const wire = wrap(body)
    const out = await new Response(chunkedStream(wire, (i) => 1 + ((i * 7919) % 70001)).pipeThrough(base64UrlMemberDecoder('raw'))).arrayBuffer()
    expect(same(new Uint8Array(out), body)).toBe(true)
  })
})
