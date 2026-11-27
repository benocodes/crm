// The store (OPS670 D5): JSON Lines, one record per case, appended as it completes.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
export const recordKey = (id: string, hash: string, version: string) => `${id}\u0000${hash}\u0000${version}`

// A line that does not parse (a crash mid-append) is dropped; every complete line before it is kept.
export function readStore(dir: string): StoreRecord[] {
  const path = join(dir, STORE_FILE)
  if (!existsSync(path)) return []
  const records: StoreRecord[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r && typeof r === 'object' && typeof r.id === 'string') records.push(r)
    } catch {}
  }
  return records
}

export function appendRecord(dir: string, record: StoreRecord): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, STORE_FILE)
  // A torn last line has no newline: end it first, so the new record starts on a line of its own.
  if (existsSync(path) && statSync(path).size > 0) {
    const fd = openSync(path, 'r')
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, statSync(path).size - 1)
    closeSync(fd)
    if (last.toString() !== '\n') appendFileSync(path, '\n')
  }
  appendFileSync(path, `${JSON.stringify(record)}\n`)
}

export function answeredKeys(records: StoreRecord[]): Set<string> {
  return new Set(
    records.filter((r) => r.status === 'answered').map((r) => recordKey(r.id, r.state_hash, r.question_set_version)),
  )
}
