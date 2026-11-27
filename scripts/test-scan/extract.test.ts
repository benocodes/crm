import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeCandidates, extract } from './extract.ts'
import { QUESTION_SET_VERSION } from './questions.ts'
import { appendRecord, type StoreRecord } from './store.ts'

// OPS670 D7 and D8: extraction over hand-written store records. No network.
type Spec = {
  id: string
  noul?: Record<string, number>
  source?: Record<string, number>
  exercises?: Record<string, number>
  risk?: number
  status?: 'answered' | 'failed'
  version?: string
  line?: number
}
const SOURCE = ['own_fixtures', 'declared_inventory', 'generated_fixture', 'refusal', 'other']
const EXERCISES = ['entry_point', 'internal_function', 'schema_metadata', 'source_text', 'constant_only']
const dist = (keys: string[], over: Record<string, number> = {}, base: string) => {
  const p: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]))
  Object.assign(p, over)
  p[base] = 1 - keys.filter((k) => k !== base).reduce((s, k) => s + (p[k] ?? 0), 0)
  return p
}
const NOULS = [
  'r1_inventory_breaks_it',
  'r2_inventory_size',
  'r3_parked_target',
  'r4_existence_only',
  'r5_mock_echo',
  'r6_library_behaviour',
  'r7_past_transition',
  'k1_refusal',
  'k2_names_bug',
  'k3_invariant',
  'k4_entry_point_result',
]
const rec = (s: Spec): StoreRecord => {
  const answers: Record<string, unknown> = {}
  for (const k of NOULS) answers[k] = { type: 'noul', noul: s.noul?.[k] ?? 0.05 }
  answers.expected_source = {
    type: 'choice',
    choice: 'own_fixtures',
    probabilities: dist(SOURCE, s.source, 'own_fixtures'),
    confidence: 0.9,
  }
  answers.exercises = {
    type: 'choice',
    choice: 'entry_point',
    probabilities: dist(EXERCISES, s.exercises, 'entry_point'),
    confidence: 0.9,
  }
  answers.bug_risk_if_deleted = { type: 'score', score: s.risk ?? 2, legend: {}, probabilities: {}, confidence: 0.5 }
  return {
    id: s.id,
    file: s.id.split(' > ')[0] ?? s.id,
    line: s.line ?? 1,
    state_hash: 'h',
    question_set_version: s.version ?? QUESTION_SET_VERSION,
    truncated: false,
    status: s.status ?? 'answered',
    ...(s.status === 'failed' ? { reason: 'x' } : { answers, usage: { input_tokens: 1, output_tokens: 0 } }),
    at: '2026-11-27T00:00:00Z',
  }
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

describe('candidates and uncertain (D7)', () => {
  it('a case at the removal threshold with a low keep signal is a candidate', () => {
    const r = computeCandidates([rec({ id: 'a', noul: { r1_inventory_breaks_it: 0.7 } })])
    expect(ids(r.candidates)).toEqual(['a'])
    expect(r.uncertain).toEqual([])
  })

  it('one keep probability above the keep threshold makes it uncertain; exactly at the threshold too', () => {
    const r = computeCandidates([
      rec({ id: 'high', noul: { r1_inventory_breaks_it: 0.9, k1_refusal: 0.6 } }),
      rec({ id: 'edge', noul: { r1_inventory_breaks_it: 0.9, k4_entry_point_result: 0.3 } }),
    ])
    expect(r.candidates).toEqual([])
    expect(ids(r.uncertain).sort()).toEqual(['edge', 'high'])
  })

  it('a case below the removal threshold is in neither list', () => {
    const r = computeCandidates([
      rec({ id: 'low', noul: { r1_inventory_breaks_it: 0.69 } }),
      rec({ id: 'lowkeep', noul: { r1_inventory_breaks_it: 0.69, k1_refusal: 0.9 } }),
    ])
    expect(r).toEqual({ candidates: [], uncertain: [] })
  })

  const sources: [string, Spec['noul'], Spec['source'], Spec['exercises']][] = [
    ['a removal noul', { r5_mock_echo: 0.8 }, undefined, undefined],
    ['expected_source = declared_inventory', undefined, { declared_inventory: 0.8 }, undefined],
    [
      'the summed schema_metadata, source_text and constant_only',
      undefined,
      undefined,
      { schema_metadata: 0.3, source_text: 0.3, constant_only: 0.2 },
    ],
  ]
  for (const [name, noul, source, exercises] of sources) {
    it(`${name} alone can make a candidate, and is named in its signals`, () => {
      const r = computeCandidates([rec({ id: 'c', noul, source, exercises })])
      expect(ids(r.candidates)).toEqual(['c'])
      const entry = r.candidates[0]
      expect(entry?.signals).toHaveLength(1)
      expect(entry?.removal_signal).toBeGreaterThanOrEqual(0.7)
      expect(entry?.keep_signal).toBeLessThan(0.3)
    })
  }

  it('each of the other two sources stays quiet when it is low (no signal from a baseline case)', () => {
    expect(computeCandidates([rec({ id: 'base' })])).toEqual({ candidates: [], uncertain: [] })
  })

  it('both thresholds are flags that re-cut the lists', () => {
    const records = [rec({ id: 'x', noul: { r2_inventory_size: 0.5, k3_invariant: 0.2 } })]
    expect(computeCandidates(records).candidates).toEqual([])
    expect(ids(computeCandidates(records, { removalThreshold: 0.5 }).candidates)).toEqual(['x'])
    expect(ids(computeCandidates(records, { removalThreshold: 0.5, keepThreshold: 0.2 }).uncertain)).toEqual(['x'])
  })

  it('ignores failed records and records of an older question-set version, and the latest answer wins', () => {
    const r = computeCandidates([
      rec({ id: 'f', status: 'failed' }),
      rec({ id: 'old', version: 'old', noul: { r1_inventory_breaks_it: 0.95 } }),
      rec({ id: 'twice', noul: { r1_inventory_breaks_it: 0.95 } }),
      rec({ id: 'twice', noul: { r1_inventory_breaks_it: 0.1 } }),
      rec({ id: 'twice2', noul: { r1_inventory_breaks_it: 0.1 } }),
      rec({ id: 'twice2', noul: { r1_inventory_breaks_it: 0.95 } }),
    ])
    expect(ids(r.candidates)).toEqual(['twice2'])
  })

  it('orders by removal signal descending, then bug risk ascending, and carries file, line and signals', () => {
    const r = computeCandidates([
      rec({ id: 'f1.test.ts > mid', line: 5, noul: { r1_inventory_breaks_it: 0.8 }, risk: 1 }),
      rec({ id: 'f2.test.ts > top', line: 9, noul: { r1_inventory_breaks_it: 0.95 }, risk: 3 }),
      rec({ id: 'f3.test.ts > tie-risky', noul: { r1_inventory_breaks_it: 0.8 }, risk: 3 }),
      rec({ id: 'f4.test.ts > tie-safe', noul: { r1_inventory_breaks_it: 0.8 }, risk: 0.5 }),
    ])
    expect(ids(r.candidates)).toEqual([
      'f2.test.ts > top',
      'f4.test.ts > tie-safe',
      'f1.test.ts > mid',
      'f3.test.ts > tie-risky',
    ])
    expect(r.candidates[0]).toMatchObject({
      file: 'f2.test.ts',
      line: 9,
      removal_signal: 0.95,
      signals: [{ name: 'r1_inventory_breaks_it', probability: 0.95 }],
      bug_risk: 3,
    })
  })
})

describe('the command (D7, D8)', () => {
  let dir: string
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })
  it('writes a JSON and a Markdown file, candidates before uncertain, and makes no network call', () => {
    dir = mkdtempSync(join(tmpdir(), 'scan-extract-'))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('network is off')
      }),
    )
    appendRecord(dir, rec({ id: 'a.test.ts > cand', line: 4, noul: { r1_inventory_breaks_it: 0.9 } }))
    appendRecord(
      dir,
      rec({ id: 'b.test.ts > unsure', line: 8, noul: { r1_inventory_breaks_it: 0.9, k1_refusal: 0.8 } }),
    )
    const r = extract(dir)
    expect(ids(r.candidates)).toEqual(['a.test.ts > cand'])
    const jsonPath = join(dir, 'candidates.json')
    const mdPath = join(dir, 'candidates.md')
    expect(existsSync(jsonPath) && existsSync(mdPath)).toBe(true)
    const json = JSON.parse(readFileSync(jsonPath, 'utf8'))
    expect(ids(json.candidates)).toEqual(['a.test.ts > cand'])
    expect(ids(json.uncertain)).toEqual(['b.test.ts > unsure'])
    const md = readFileSync(mdPath, 'utf8')
    expect(md).toContain('a.test.ts:4')
    expect(md.indexOf('a.test.ts > cand')).toBeLessThan(md.indexOf('b.test.ts > unsure'))
    expect(fetch).not.toHaveBeenCalled()
  })
})
