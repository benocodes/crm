// The scan run (OPS670 D4 to D6). Stub: the red commit.
import type { Question } from './questions.ts'

export type ScanOptions = {
  questionSet?: { version: string; questions: Record<string, Question> }
  root: string
  outDir: string
  env: Record<string, string | undefined>
  paths?: string[]
  files?: string[]
  limit?: number
  concurrency?: number
  maxInputTokens?: number
  maxStateChars?: number
  dryRun?: boolean
  baseUrl?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
  log?: (line: string) => void
}
export type ScanSummary = {
  files: number
  cases: number
  sent: number
  skipped: number
  answered: number
  failed: number
  truncated: number
  unparsed: number
  empty: number
  input_tokens: number
}
export const EXIT = { ok: 0, failed: 1, refused: 2, ceiling: 3 } as const
export async function scan(_opts: ScanOptions): Promise<{ exitCode: number; summary: ScanSummary }> {
  throw new Error('not implemented')
}
