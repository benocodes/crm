// Test-only (OPS340, [[OPS338]]): the request transport. One HTTP request per statement or batch, sent to a harness Worker that runs
// in the same Miniflare as the databases and executes it on the real D1 binding (`env.<name>`). The binding transport
// (`mf.getD1Database`) costs one workerd round trip per method call and blocks the Node thread on two of three; this costs one,
// asynchronously, so statements really overlap. Nothing here is imported by a shipped bundle.
import http from 'node:http'
import type { D1Like, D1PreparedLike, D1ResultLike } from '../binding.js'

export type TransportKind = 'binding' | 'request'

/** D6: the pool bound per instance. Sixteen keeps a `Promise.all` burst from exhausting ephemeral ports (the prototype's EADDRNOTAVAIL) yet is wide enough that workerd, not the pool, is the limit. */
export const MAX_SOCKETS = 16

export interface TransportStats {
  readonly maxSockets: number
  /** Sockets the agent ever opened. */
  readonly opened: number
  /** Sockets open now. */
  readonly open: number
  readonly peakOpen: number
  /** Most requests awaiting a response at once, queued ones included: above one means statements overlapped. */
  readonly peakInFlight: number
  readonly requests: number
  /** `close()` has destroyed the agent. */
  readonly closed: boolean
}

/**
 * The value codec (D7), written once as plain JavaScript source: the harness Worker embeds it and Node evaluates the same text, so the
 * two sides cannot drift. JSON carries only what it carries; everything else travels tagged as `{ "$t": ... }` and is rebuilt exactly:
 * bytes (any ArrayBuffer or view), bigint, undefined, non-finite numbers and negative zero, Date. A plain object that itself has a
 * `$t` key is wrapped so it cannot be mistaken for a tag. A function, symbol or class instance is refused, as D1 refuses it.
 */
export const CODEC_SOURCE = `
const B64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s) }
const UNB64 = (text) => { const s = atob(text); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b }
const VIEWS = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView }
const tag = (v) => Object.prototype.toString.call(v).slice(8, -1)
const unsupported = (type, text) => Object.assign(new Error("D1_TYPE_ERROR: Type '" + type + "' not supported for value '" + text + "'"), { cause: new Error("Type '" + type + "' not supported for value '" + text + "'") })
function encode(v) {
  if (v === undefined) return { $t: 'undefined' }
  if (v === null) return null
  switch (typeof v) {
    case 'bigint': return { $t: 'bigint', v: String(v) }
    case 'number': return Number.isFinite(v) && !Object.is(v, -0) ? v : { $t: 'number', v: String(v) }
    case 'string': case 'boolean': return v
    case 'function': case 'symbol': throw new TypeError('cannot send a ' + typeof v + ' to D1')
  }
  if (tag(v) === 'ArrayBuffer') return { $t: 'bytes', c: 'ArrayBuffer', v: B64(new Uint8Array(v)) }
  if (ArrayBuffer.isView(v)) {
    const c = tag(v)
    return { $t: 'bytes', c: c in VIEWS ? c : 'Uint8Array', v: B64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) }
  }
  if (v instanceof Date) { const t = v.getTime(); return { $t: 'date', v: Number.isNaN(t) ? 'NaN' : t } }
  if (Array.isArray(v)) return v.map(encode)
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) throw unsupported('object', String(v))
  const out = {}
  for (const k of Object.keys(v)) out[k] = encode(v[k])
  return Object.prototype.hasOwnProperty.call(v, '$t') ? { $t: 'obj', v: out } : out
}
function decode(v) {
  if (Array.isArray(v)) return v.map(decode)
  if (v === null || typeof v !== 'object') return v
  if (!Object.prototype.hasOwnProperty.call(v, '$t')) { const out = {}; for (const k of Object.keys(v)) out[k] = decode(v[k]); return out }
  switch (v.$t) {
    case 'undefined': return undefined
    case 'bigint': return BigInt(v.v)
    case 'number': return Number(v.v)
    case 'date': return new Date(v.v === 'NaN' ? NaN : v.v)
    case 'bytes': { const b = UNB64(v.v); return v.c === 'ArrayBuffer' ? b.buffer : v.c === 'Uint8Array' ? b : new VIEWS[v.c](b.buffer) }
    case 'obj': { const out = {}; for (const k of Object.keys(v.v)) out[k] = decode(v.v[k]); return out }
  }
  throw new Error('unknown value tag ' + v.$t)
}
`

const codec = new Function(`${CODEC_SOURCE}; return { encode, decode }`)() as {
  encode(v: unknown): unknown
  decode(v: unknown): unknown
}

/** The harness Worker: `POST { db, op, statements }` answers `{ ok, result }` or `{ ok: false, error: { name, message, cause } }`. It knows nothing about the schema. */
export function harnessScript(): string {
  return `${CODEC_SOURCE}
const errorOf = (err, depth = 0) => {
  if (err === null || err === undefined) return null
  if (typeof err !== 'object') return { name: 'Error', message: String(err), cause: null }
  return { name: String(err.name), message: String(err.message), cause: depth < 8 ? errorOf(err.cause, depth + 1) : null }
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 })
    let body
    try { body = JSON.parse(await request.text()) } catch { return new Response('bad json', { status: 400 }) }
    try {
      const db = Object.prototype.hasOwnProperty.call(env, body.db) ? env[body.db] : undefined
      if (!db) throw new Error('harness: unknown database ' + body.db)
      const prepare = (s) => db.prepare(s.sql).bind(...decode(s.params))
      let result
      if (body.op === 'batch') result = await db.batch(body.statements.map(prepare))
      else if (body.op === 'run' || body.op === 'all' || body.op === 'first') {
        if (body.statements.length !== 1) throw new Error('harness: ' + body.op + ' takes exactly one statement')
        result = await prepare(body.statements[0])[body.op]()
      } else throw new Error('harness: unknown op ' + body.op)
      return reply({ ok: true, result: encode(result) })
    } catch (err) {
      return reply({ ok: false, error: errorOf(err) })
    }
  },
}
`
}

interface WireError {
  name: string
  message: string
  cause: WireError | null
}
const rebuild = (w: WireError | null): Error | undefined => {
  if (!w) return undefined
  const cause = rebuild(w.cause)
  const err = cause ? new Error(w.message, { cause }) : new Error(w.message)
  if (w.name !== 'Error') err.name = w.name
  return err
}

class CountingAgent extends http.Agent {
  opened = 0
  open = 0
  peakOpen = 0
  readonly live = new Set<import('node:net').Socket>()
  override createConnection(options: unknown, cb?: unknown): import('node:net').Socket {
    // biome-ignore lint/suspicious/noExplicitAny: Node's Agent typings leave createConnection's signature open
    const socket = (super.createConnection as any)(options, cb) as import('node:net').Socket
    this.opened++
    this.open++
    this.peakOpen = Math.max(this.peakOpen, this.open)
    this.live.add(socket)
    socket.once('close', () => {
      this.open--
      this.live.delete(socket)
    })
    return socket
  }
}

class Statement implements D1PreparedLike {
  constructor(
    readonly transport: Transport,
    readonly db: string,
    readonly sql: string,
    readonly params: readonly unknown[],
  ) {}
  bind(...values: unknown[]): D1PreparedLike {
    return new Statement(this.transport, this.db, this.sql, values)
  }
  run(): Promise<D1ResultLike> {
    return this.transport.send(this.db, 'run', [this]) as Promise<D1ResultLike>
  }
  all(): Promise<D1ResultLike> {
    return this.transport.send(this.db, 'all', [this]) as Promise<D1ResultLike>
  }
  first(): Promise<Record<string, unknown> | null> {
    return this.transport.send(this.db, 'first', [this]) as Promise<Record<string, unknown> | null>
  }
}

class Transport {
  readonly agent = new CountingAgent({ keepAlive: true, maxSockets: MAX_SOCKETS })
  private inFlight = 0
  private peakInFlight = 0
  private requests = 0
  private closed = false
  constructor(
    private readonly url: URL,
    maxSockets: number,
  ) {
    this.agent.maxSockets = maxSockets
  }

  stats(): TransportStats {
    return {
      maxSockets: this.agent.maxSockets,
      opened: this.agent.opened,
      open: this.agent.open,
      peakOpen: this.agent.peakOpen,
      peakInFlight: this.peakInFlight,
      requests: this.requests,
      closed: this.closed,
    }
  }

  async send(db: string, op: 'run' | 'all' | 'first' | 'batch', statements: readonly Statement[]): Promise<unknown> {
    const payload = JSON.stringify({
      db,
      op,
      statements: statements.map((s) => ({ sql: s.sql, params: s.params.map((p) => codec.encode(p)) })),
    })
    this.requests++
    this.inFlight++
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight)
    try {
      const text = await this.post(payload)
      const body = JSON.parse(text) as { ok: true; result: unknown } | { ok: false; error: WireError }
      if (!body.ok) throw rebuild(body.error) ?? new Error('harness: empty error')
      return codec.decode(body.result)
    } finally {
      this.inFlight--
    }
  }

  private post(payload: string): Promise<string> {
    const data = Buffer.from(payload)
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          agent: this.agent,
          method: 'POST',
          hostname: this.url.hostname,
          port: this.url.port,
          path: '/',
          headers: { 'content-type': 'application/json', 'content-length': data.length },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('error', reject)
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (res.statusCode !== 200) reject(new Error(`harness: HTTP ${res.statusCode}: ${text.slice(0, 200)}`))
            else resolve(text)
          })
        },
      )
      req.on('error', reject)
      req.end(data)
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    const sockets = [...this.agent.live]
    const gone = sockets.map((s) =>
      s.destroyed ? Promise.resolve() : new Promise<void>((r) => s.once('close', () => r())),
    )
    this.agent.destroy()
    this.closed = true
    await Promise.all(gone)
  }
}

class RequestD1 implements D1Like {
  constructor(
    private readonly transport: Transport,
    private readonly name: string,
  ) {}
  prepare(query: string): D1PreparedLike {
    return new Statement(this.transport, this.name, query, [])
  }
  async batch(statements: D1PreparedLike[]): Promise<D1ResultLike[]> {
    const own = statements.map((s) => {
      if (!(s instanceof Statement) || s.db !== this.name)
        throw new TypeError('request transport: batch() takes statements prepared on this same handle')
      return s
    })
    return (await this.transport.send(this.name, 'batch', own)) as D1ResultLike[]
  }
}

export interface RequestTransport {
  readonly bindings: Record<string, D1Like>
  stats(): TransportStats
  close(): Promise<void>
}

/** One handle per name, created once: a binding's handle is the same object for the life of the instance. */
export function createRequestTransport(
  url: URL,
  names: readonly string[],
  opts: { maxSockets?: number } = {},
): RequestTransport {
  const transport = new Transport(url, opts.maxSockets ?? MAX_SOCKETS)
  const bindings: Record<string, D1Like> = {}
  for (const name of names) bindings[name] = new RequestD1(transport, name)
  return { bindings, stats: () => transport.stats(), close: () => transport.close() }
}

// What `openLocalD1` chose for an instance, for the tests that need to see it (`LocalD1`'s shape stays as it was).
const registry = new WeakMap<object, { kind: TransportKind; transport?: RequestTransport }>()
export function registerTransport(local: object, kind: TransportKind, transport?: RequestTransport): void {
  registry.set(local, { kind, transport })
}
export function transportStats(local: object): TransportStats | undefined {
  return registry.get(local)?.transport?.stats()
}
export function transportKindOf(local: object): TransportKind {
  const entry = registry.get(local)
  if (!entry) throw new Error('not an instance opened by openLocalD1')
  return entry.kind
}

/** D9: the option wins; else `VIBASE_TEST_D1_TRANSPORT` (`binding` or `request`, anything else throws); else `request`. */
export function resolveTransport(option: TransportKind | undefined): TransportKind {
  if (option !== undefined) return option
  const value = process.env.VIBASE_TEST_D1_TRANSPORT
  if (value === undefined || value === '' || value === 'request') return 'request'
  if (value === 'binding') return 'binding'
  throw new Error(`VIBASE_TEST_D1_TRANSPORT must be "binding" or "request", got "${value}"`)
}
