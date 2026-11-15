// OPS340 D8: one catalogue of statements through the binding transport and through the request transport; rows, `meta` (less its
// timing fields) and errors (name, message, cause chain) must be identical. The request transport sits between every D1 test and
// the oracle, so a value it alters or an error it flattens would make every suite above it prove something else.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from '../binding.js'
import { openLocalD1, type LocalD1 } from './index.js'

let binding: LocalD1
let request: LocalD1

const SCHEMA = [
  'CREATE TABLE vals (id INTEGER PRIMARY KEY AUTOINCREMENT, v)',
  'CREATE TABLE uq (k TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 0), u TEXT UNIQUE)',
  'CREATE TABLE parent (id INTEGER PRIMARY KEY)',
  'CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES parent(id))',
  'CREATE TABLE mid (id INTEGER PRIMARY KEY, label TEXT UNIQUE)',
]

beforeAll(async () => {
  ;[binding, request] = await Promise.all([
    openLocalD1(['A', 'B'], { migrate: false, transport: 'binding' }),
    openLocalD1(['A', 'B'], { migrate: false, transport: 'request' }),
  ])
  for (const local of [binding, request])
    for (const name of ['A', 'B']) {
      const d1 = local.bindings[name]!
      await d1.batch(SCHEMA.map((s) => d1.prepare(s)))
    }
}, 60_000)

afterAll(async () => {
  await Promise.all([binding?.dispose(), request?.dispose()])
})

const TIMING_FIELDS = new Set(['duration', 'timings'])

interface ErrorShape {
  ctor: string
  name: string
  message: string
  cause: ErrorShape | null
}
const errorShape = (err: unknown): ErrorShape => {
  const e = err as { constructor?: { name?: string }; name?: string; message?: string; cause?: unknown } | null
  return {
    ctor: e?.constructor?.name ?? typeof err,
    name: e?.name ?? '',
    message: e?.message ?? String(err),
    cause: e?.cause === undefined || e?.cause === null ? null : errorShape(e.cause),
  }
}

/** A comparable form that keeps what JSON would lose (undefined, bigint, special numbers, byte views) and drops timing fields. */
const norm = (v: unknown, key = ''): unknown => {
  if (v === undefined) return { $: 'undefined' }
  if (typeof v === 'bigint') return { $: 'bigint', v: String(v) }
  if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) return { $: 'number', v: String(v) }
  if (v instanceof ArrayBuffer) return { $: 'ArrayBuffer', bytes: [...new Uint8Array(v)] }
  if (ArrayBuffer.isView(v))
    return { $: v.constructor.name, bytes: [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)] }
  if (v instanceof Date) return { $: 'Date', v: v.getTime() }
  if (Array.isArray(v)) return v.map((x) => norm(x))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      if (key === 'meta' && TIMING_FIELDS.has(k)) continue
      out[k] = norm((v as Record<string, unknown>)[k], k)
    }
    return out
  }
  return v
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: ErrorShape }
const outcome = async (fn: () => Promise<unknown>): Promise<Outcome> => {
  try {
    return { ok: true, value: norm(await fn()) }
  } catch (err) {
    return { ok: false, error: errorShape(err) }
  }
}

interface Handles {
  a: D1Like
  b: D1Like
}
interface Case {
  name: string
  run: (h: Handles) => Promise<unknown>
  /** Both transports must reject, but the rejection comes from the Node-to-workerd plumbing and not from D1, so its text is not comparable (D7). */
  rejectsOnly?: boolean
}

const echo = (h: Handles, value: unknown) => h.a.prepare('SELECT ? AS v, typeof(?) AS t').bind(value, value).all()
const roundTrip = async (h: Handles, value: unknown) => {
  const inserted = await h.a.prepare('INSERT INTO vals (v) VALUES (?)').bind(value).run()
  const back = await h.a.prepare('SELECT v, typeof(v) AS t FROM vals ORDER BY id DESC LIMIT 1').all()
  return { inserted, back }
}

const cases: Case[] = []
const add = (name: string, run: Case['run'], rejectsOnly = false) => cases.push({ name, run, rejectsOnly })

// Every bound type the storage layer uses.
add('bind null', (h) => roundTrip(h, null))
add('bind integer', (h) => roundTrip(h, 42))
add('bind integer beyond 2^31', (h) => roundTrip(h, 2 ** 31 + 5))
add('bind integer near 2^53', (h) => roundTrip(h, Number.MAX_SAFE_INTEGER))
add('bind negative integer near -2^53', (h) => roundTrip(h, -Number.MAX_SAFE_INTEGER))
add('bind float', (h) => roundTrip(h, 1.5))
add('bind text', (h) => roundTrip(h, 'héllo "quoted" \u{1F600} \\'))
add('bind empty string', (h) => roundTrip(h, ''))
add('bind boolean true', (h) => echo(h, true))
add('bind boolean false', (h) => echo(h, false))
add('bind blob as ArrayBuffer', (h) => roundTrip(h, new Uint8Array([0, 1, 2, 250, 255]).buffer))
add('bind blob as Uint8Array', (h) => roundTrip(h, new Uint8Array([9, 8, 7, 0, 255])))
add('bind blob as Uint16Array', (h) => roundTrip(h, new Uint16Array([1, 2, 65535])))
add('bind blob as sub-view of a larger buffer', (h) => roundTrip(h, new Uint8Array([1, 2, 3, 4, 5, 6]).subarray(2, 5)))
add('bind empty blob', (h) => roundTrip(h, new Uint8Array(0)))
add('read blob column as it comes back', (h) => h.a.prepare("SELECT x'00ff10' AS b, typeof(x'00ff10') AS t").first())
add('read large integer column', (h) => h.a.prepare('SELECT 4294967296 AS big, 9007199254740991 AS safe').all())

// Values JSON would change silently (D7), as a single bind and inside a batch.
const odd: [string, () => unknown, boolean?][] = [
  ['undefined', () => undefined],
  ['bigint', () => 5n],
  ['Date', () => new Date('2026-01-02T03:04:05.000Z')],
  ['invalid Date', () => new Date(Number.NaN)],
  ['plain object', () => ({ a: 1, b: [1, 2] })],
  ['array', () => [1, 'two', null]],
  ['object with a $t key', () => ({ $t: 'bytes', v: 'AAAA' })],
  ['Map', () => new Map()],
  ['NaN', () => Number.NaN],
  ['Infinity', () => Number.POSITIVE_INFINITY],
  ['-Infinity', () => Number.NEGATIVE_INFINITY],
  ['negative zero', () => -0],
  ['function', () => () => 1, true],
  ['symbol', () => Symbol('x'), true],
]
for (const [label, make, rejectsOnly] of odd) {
  add(`bind ${label} in a single statement`, (h) => echo(h, make()), rejectsOnly)
  add(
    `bind ${label} inside a batch`,
    (h) =>
      h.a.batch([
        h.a.prepare('SELECT 1 AS first_statement'),
        h.a.prepare('SELECT ? AS v, typeof(?) AS t').bind(make(), make()),
      ]),
    rejectsOnly,
  )
}

// Result shapes.
add('first() on no row', (h) => h.a.prepare('SELECT * FROM vals WHERE id = -1').first())
add('first() on a row', (h) => h.a.prepare("SELECT 1 AS one, 'x' AS two").first())
add('all() on no rows', (h) => h.a.prepare('SELECT * FROM vals WHERE id = -1').all())
add('run() of a select', (h) => h.a.prepare('SELECT 1 AS one').run())
add('all() of an insert carries meta', (h) => h.a.prepare('INSERT INTO mid (label) VALUES (?)').bind('m1').all())
add('run() of an update carries changes', (h) => h.a.prepare("UPDATE mid SET label = 'm1b' WHERE label = ?").bind('m1').run())
add('run() of a delete that matches nothing', (h) => h.a.prepare("DELETE FROM mid WHERE label = 'nothing'").run())
add('statement without bind', (h) => h.a.prepare('SELECT 7 AS seven').all())
add('bind() with no values', (h) => h.a.prepare('SELECT 7 AS seven').bind().all())
add('bind twice keeps the last binding', (h) => h.a.prepare('SELECT ? AS v').bind(1).bind(2).all())
add('a statement can be reused with new bindings', async (h) => {
  const base = h.a.prepare('SELECT ? AS v')
  const first = await base.bind('first').all()
  const second = await base.bind('second').all()
  return { first, second }
})

// Batches.
add('multi-statement batch', (h) =>
  h.a.batch([
    h.a.prepare('INSERT INTO mid (label) VALUES (?)').bind('b1'),
    h.a.prepare('INSERT INTO mid (label) VALUES (?)').bind('b2'),
    h.a.prepare('SELECT label FROM mid WHERE label LIKE ? ORDER BY label').bind('b%'),
  ]),
)
add('one-statement batch', (h) => h.a.batch([h.a.prepare('SELECT 1 AS one')]))
add('empty batch', (h) => h.a.batch([]))
add('batch that fails midway, then what it left behind', async (h) => {
  const failed = await outcome(() =>
    h.a.batch([
      h.a.prepare('INSERT INTO mid (label) VALUES (?)').bind('mid1'),
      h.a.prepare('INSERT INTO mid (label) VALUES (?)').bind('mid1'),
      h.a.prepare('INSERT INTO mid (label) VALUES (?)').bind('mid3'),
    ]),
  )
  const left = await h.a.prepare("SELECT label FROM mid WHERE label LIKE 'mid%' ORDER BY label").all()
  return { failed, left }
})

// Each constraint error the storage layer matches (`packages/storage-d1/src/index.ts`), and the SQLITE_* family.
add('UNIQUE constraint failed (primary key)', async (h) => {
  await h.a.prepare('INSERT INTO uq (k, n) VALUES (?, ?)').bind('pk', 1).run()
  return h.a.prepare('INSERT INTO uq (k, n) VALUES (?, ?)').bind('pk', 2).run()
})
add('UNIQUE constraint failed (unique column)', async (h) => {
  await h.a.prepare('INSERT INTO uq (k, n, u) VALUES (?, ?, ?)').bind('u1', 1, 'same').run()
  return h.a.prepare('INSERT INTO uq (k, n, u) VALUES (?, ?, ?)').bind('u2', 1, 'same').run()
})
add('UNIQUE constraint failed inside a batch', (h) =>
  h.a.batch([
    h.a.prepare('INSERT INTO uq (k, n, u) VALUES (?, ?, ?)').bind('u3', 1, 'other'),
    h.a.prepare('INSERT INTO uq (k, n, u) VALUES (?, ?, ?)').bind('u4', 1, 'other'),
  ]),
)
add('FOREIGN KEY constraint failed', (h) => h.a.prepare('INSERT INTO child (pid) VALUES (?)').bind(999).run())
add('CHECK constraint failed', (h) => h.a.prepare('INSERT INTO uq (k, n) VALUES (?, ?)').bind('chk', -1).run())
add('NOT NULL constraint failed', (h) => h.a.prepare('INSERT INTO uq (k, n) VALUES (?, ?)').bind('nn', null).run())
add('syntax error', (h) => h.a.prepare('SELEC 1').all())
add('no such table', (h) => h.a.prepare('SELECT * FROM missing_table').all())
add('no such column', (h) => h.a.prepare('SELECT missing_column FROM vals').all())
add('wrong number of parameter bindings', (h) => h.a.prepare('SELECT ?').all())
add('too many parameter bindings', (h) => h.a.prepare('SELECT 1').bind(1, 2).all())

// An instance has two databases, each its own.
add('a statement on each of the instance databases', async (h) => {
  await h.a.prepare('INSERT INTO mid (label) VALUES (?)').bind('only-on-a').run()
  const onA = await h.a.prepare("SELECT label FROM mid WHERE label = 'only-on-a'").all()
  const onB = await h.b.prepare("SELECT label FROM mid WHERE label = 'only-on-a'").all()
  await h.b.prepare('INSERT INTO mid (label) VALUES (?)').bind('only-on-b').run()
  const bOnB = await h.b.prepare("SELECT label FROM mid WHERE label = 'only-on-b'").all()
  const bOnA = await h.a.prepare("SELECT label FROM mid WHERE label = 'only-on-b'").all()
  return { onA, onB, bOnB, bOnA }
})

describe('transport parity (OPS340 D8)', () => {
  it('the catalogue is not empty and names are unique', () => {
    expect(cases.length).toBeGreaterThan(60)
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    // The same case, in the same order, on both instances, so shared state (last_row_id, rows left behind) stays comparable.
    const viaBinding = await outcome(() => c.run({ a: binding.bindings.A!, b: binding.bindings.B! }))
    const viaRequest = await outcome(() => c.run({ a: request.bindings.A!, b: request.bindings.B! }))
    if (c.rejectsOnly) {
      expect(viaBinding.ok).toBe(false)
      expect(viaRequest.ok).toBe(false)
      return
    }
    expect(viaRequest).toEqual(viaBinding)
  })

  it('the request transport is not the binding transport (the comparison compares two things)', () => {
    expect(request.bindings.A).not.toBe(binding.bindings.A)
    expect(Object.getPrototypeOf(request.bindings.A)).not.toBe(Object.getPrototypeOf(binding.bindings.A))
  })
})
