// The store (OPS670 D5). Stub: the red commit.
import type { Usage } from './clef.ts'

export type StoreRecord = {
  id: string
  file: string
  line: number
  state_hash: string
  question_set_version: string
  truncated: boolean
  status: 'answered' | 'failed'
  answers?: Record<string, unknown>
  usage?: Usage
  reason?: string
  at: string
}
export const STORE_FILE = 'answers.jsonl'
export function readStore(_dir: string): StoreRecord[] {
  throw new Error('not implemented')
}
export function appendRecord(_dir: string, _record: StoreRecord): void {
  throw new Error('not implemented')
}
export function answeredKeys(_records: StoreRecord[]): Set<string> {
  throw new Error('not implemented')
}
export const recordKey = (id: string, hash: string, version: string) => `${id}\u0000${hash}\u0000${version}`
