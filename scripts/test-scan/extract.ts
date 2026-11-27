// Extraction (OPS670 D7). Stub: the red commit.
import type { StoreRecord } from './store.ts'

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
export type ExtractOptions = { removalThreshold?: number; keepThreshold?: number }
export function computeCandidates(_records: StoreRecord[], _opts?: ExtractOptions): Extraction {
  throw new Error('not implemented')
}
export function extract(_dir: string, _opts?: ExtractOptions): Extraction {
  throw new Error('not implemented')
}
