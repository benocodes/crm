// Extraction (OPS670 D7): reads the store and calls nothing. It writes no test file either (D8): only two files in the store directory.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QUESTION_SET_VERSION } from './questions.ts'
import { readStore, type StoreRecord } from './store.ts'

export type Signal = { name: string; probability: number }
export type Entry = {
  id: string
  file: string
  line: number
  removal_signal: number
  signals: Signal[]
  keep_signal: number
  bug_risk: number | null
}
export type Extraction = { candidates: Entry[]; uncertain: Entry[] }
export type ExtractOptions = { removalThreshold?: number; keepThreshold?: number; version?: string }
export const DEFAULT_REMOVAL_THRESHOLD = 0.7
export const DEFAULT_KEEP_THRESHOLD = 0.3
export const CANDIDATES_JSON = 'candidates.json'
export const CANDIDATES_MD = 'candidates.md'

const REMOVAL_NOULS = [
  'r1_inventory_breaks_it',
  'r2_inventory_size',
  'r3_parked_target',
  'r4_existence_only',
  'r5_mock_echo',
  'r6_library_behaviour',
  'r7_past_transition',
]
const KEEP_NOULS = ['k1_refusal', 'k2_names_bug', 'k3_invariant', 'k4_entry_point_result']
const BAD_EXERCISES = ['schema_metadata', 'source_text', 'constant_only']

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const field = (a: unknown, ...path: string[]): unknown => {
  let v = a
  for (const p of path) v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[p] : undefined
  return v
}

export function computeCandidates(records: StoreRecord[], opts: ExtractOptions = {}): Extraction {
  const removalAt = opts.removalThreshold ?? DEFAULT_REMOVAL_THRESHOLD
  const keepBelow = opts.keepThreshold ?? DEFAULT_KEEP_THRESHOLD
  const version = opts.version ?? QUESTION_SET_VERSION

  // The latest answered record of each case at the current question-set version.
  const latest = new Map<string, StoreRecord>()
  for (const r of records)
    if (r.status === 'answered' && r.question_set_version === version && r.answers) latest.set(r.id, r)

  const candidates: Entry[] = []
  const uncertain: Entry[] = []
  for (const r of latest.values()) {
    const a = r.answers
    const signals: Signal[] = REMOVAL_NOULS.map((k) => ({ name: k, probability: num(field(a, k, 'noul')) }))
    signals.push({
      name: 'expected_source=declared_inventory',
      probability: num(field(a, 'expected_source', 'probabilities', 'declared_inventory')),
    })
    signals.push({
      name: `exercises=${BAD_EXERCISES.join('+')}`,
      probability: BAD_EXERCISES.reduce((s, k) => s + num(field(a, 'exercises', 'probabilities', k)), 0),
    })
    const removal = Math.max(...signals.map((s) => s.probability))
    if (removal < removalAt) continue
    const keep = Math.max(...KEEP_NOULS.map((k) => num(field(a, k, 'noul'))))
    const risk = field(a, 'bug_risk_if_deleted', 'score')
    const entry: Entry = {
      id: r.id,
      file: r.file,
      line: r.line,
      removal_signal: removal,
      signals: signals.filter((s) => s.probability >= removalAt),
      keep_signal: keep,
      bug_risk: typeof risk === 'number' ? risk : null,
    }
    ;(keep < keepBelow ? candidates : uncertain).push(entry)
  }
  const order = (a: Entry, b: Entry) =>
    b.removal_signal - a.removal_signal ||
    (a.bug_risk ?? Number.POSITIVE_INFINITY) - (b.bug_risk ?? Number.POSITIVE_INFINITY)
  return { candidates: candidates.sort(order), uncertain: uncertain.sort(order) }
}

const pct = (n: number) => n.toFixed(2)

function markdown(x: Extraction, o: Required<Pick<ExtractOptions, 'removalThreshold' | 'keepThreshold'>>): string {
  const section = (title: string, entries: Entry[]) => [
    `## ${title} (${entries.length})`,
    '',
    ...(entries.length === 0
      ? ['None.', '']
      : entries.flatMap((e) => [
          `- \`${e.file}:${e.line}\` ${e.id}`,
          `  - removal ${pct(e.removal_signal)}: ${e.signals.map((s) => `${s.name} ${pct(s.probability)}`).join(', ')}`,
          `  - keep ${pct(e.keep_signal)}, bug risk if deleted ${e.bug_risk === null ? 'unknown' : pct(e.bug_risk)}`,
        ])),
  ]
  return [
    '# Test removal candidates',
    '',
    `Removal threshold ${o.removalThreshold}, keep threshold ${o.keepThreshold}. Every entry is for review: nothing here is deleted.`,
    '',
    ...section('Candidates', x.candidates),
    ...section('Uncertain (a keep signal is high)', x.uncertain),
  ].join('\n')
}

export function extract(dir: string, opts: ExtractOptions = {}): Extraction {
  const result = computeCandidates(readStore(dir), opts)
  mkdirSync(dir, { recursive: true })
  const thresholds = {
    removalThreshold: opts.removalThreshold ?? DEFAULT_REMOVAL_THRESHOLD,
    keepThreshold: opts.keepThreshold ?? DEFAULT_KEEP_THRESHOLD,
  }
  writeFileSync(
    join(dir, CANDIDATES_JSON),
    `${JSON.stringify({ question_set_version: opts.version ?? QUESTION_SET_VERSION, thresholds, ...result }, null, 2)}\n`,
  )
  writeFileSync(join(dir, CANDIDATES_MD), `${markdown(result, thresholds)}\n`)
  return result
}
