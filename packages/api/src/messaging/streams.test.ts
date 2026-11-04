import { describe, expect, it } from 'vitest'
import { nodeStreams } from '../test/streams.js'
import { workerdStreams } from './streams.js'

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const streamOf = (bytes: Uint8Array) => new Blob([bytes.slice()]).stream() as ReadableStream<Uint8Array>
const drain = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer())

describe('workerdStreams (D4)', () => {
  it('throws at construction when crypto.DigestStream is absent', () => {
    expect(() => workerdStreams({ crypto: {}, FixedLengthStream: class {} })).toThrow(/DigestStream/)
  })
  it('throws at construction when FixedLengthStream is absent', () => {
    expect(() => workerdStreams({ crypto: { DigestStream: class {} } })).toThrow(/FixedLengthStream/)
  })
  it('throws on Node itself, which has neither global', () => {
    expect(() => workerdStreams()).toThrow()
  })
  it('builds a sha256 sink from the DigestStream global and a fixed-length stream from FixedLengthStream', async () => {
    const made: unknown[] = []
    class DigestStream extends WritableStream<Uint8Array> {
      readonly digest: Promise<ArrayBuffer>
      constructor(readonly algorithm: string) {
        let done!: (b: ArrayBuffer) => void
        super({ close: () => done(new ArrayBuffer(1)) })
        this.digest = new Promise((r) => (done = r))
      }
    }
    class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
      constructor(readonly expected: number) {
        super()
        made.push(expected)
      }
    }
    const s = workerdStreams({ crypto: { DigestStream }, FixedLengthStream })
    const sink = s.sha256()
    expect(sink.writable).toBeInstanceOf(DigestStream)
    expect((sink.writable as DigestStream).algorithm).toBe('SHA-256')
    const t = s.fixedLength(42)
    expect(t).toBeInstanceOf(FixedLengthStream)
    expect(made).toEqual([42])
  })
})

describe('nodeStreams (test kit)', () => {
  it('hashes what is written', async () => {
    const s = nodeStreams().sha256()
    await streamOf(new TextEncoder().encode('abc')).pipeTo(s.writable)
    expect(hex(await s.digest)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('fixedLength passes the right number of bytes and fails otherwise', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    expect([...(await drain(streamOf(bytes).pipeThrough(nodeStreams().fixedLength(4))))]).toEqual([1, 2, 3, 4])
    await expect(drain(streamOf(bytes).pipeThrough(nodeStreams().fixedLength(5)))).rejects.toThrow()
    await expect(drain(streamOf(bytes).pipeThrough(nodeStreams().fixedLength(3)))).rejects.toThrow()
  })
})
