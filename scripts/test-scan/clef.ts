// The Clef client (OPS670 D4). Stub: the red commit.
import type { Question } from './questions.ts'

export type Usage = { input_tokens: number; output_tokens: number }
export type ClefOutcome = { ok: true; answers: Record<string, unknown>; usage: Usage } | { ok: false; reason: string }
export type ClefOptions = {
  accountId: string
  token: string
  baseUrl?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
}
export function validateAnswers(_answers: unknown, _questions: Record<string, Question>): string | undefined {
  throw new Error('not implemented')
}
export function redact(_text: string, _token: string): string {
  throw new Error('not implemented')
}
export async function askClef(
  _state: unknown,
  _questions: Record<string, Question>,
  _opts: ClefOptions,
): Promise<ClefOutcome> {
  throw new Error('not implemented')
}
