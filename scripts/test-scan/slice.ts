// Slice test files into cases (OPS670 D1, D2). Stub: the red commit.
export type CaseState = {
  path: string
  describes: string[]
  imports: string[]
  hooks: string[]
  declarations: string[]
  case: string
}
export type Case = {
  id: string
  file: string
  line: number
  title: string
  describes: string[]
  state: CaseState
  stateHash: string
  truncated: boolean
}
export type SliceResult = { status: 'ok' | 'empty' | 'unparsed'; cases: Case[]; reason?: string }
export const DEFAULT_MAX_STATE_CHARS = 24_000

export function sliceSource(_file: string, _text: string, _opts: { maxChars?: number } = {}): SliceResult {
  throw new Error('not implemented')
}
export function listTestFiles(_root: string): string[] {
  throw new Error('not implemented')
}
export type SliceFilesResult = {
  cases: Case[]
  unparsed: { file: string; reason: string }[]
  empty: string[]
  files: number
}
export function sliceFiles(_root: string, _files: string[], _opts: { maxChars?: number } = {}): SliceFilesResult {
  throw new Error('not implemented')
}
