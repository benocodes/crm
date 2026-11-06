// STUB for the red commit ([[CHN153]]): the names the tests import, with no behaviour. Replaced by the implementation in the green commit.
import type { R2BucketLike } from '../../objects/store.js'

const nope = (): never => {
  throw new Error('not implemented')
}
export const RECORDINGS_PREFIX = '_recordings/'
export const RECORDINGS_INDEX_KEY = `${RECORDINGS_PREFIX}index.json`
export const RECORDING_MAX_DAYS = 7
export const RECORDING_CAP = 3
export interface RecordingSwitch {
  until: Date | null
  problem: 'malformed' | 'too_far' | null
}
export const parseRecordingSwitch = (_raw: string | undefined, _now: Date): RecordingSwitch => nope()
export const recordingProblemNotice = (_p: 'malformed' | 'too_far'): string => nope()
export const maskText = (_s: string): string => nope()
export const maskHeaderValue = (_s: string): string => nope()
export interface Base64Summary {
  length: number
  padding: number
  alphabet_ok: boolean
  decoded_bytes: number
}
export const summarizeBase64 = (_s: string): Base64Summary => nope()
export class Pseudonyms {
  constructor(_random: (n: number) => Uint8Array) {}
  of(_s: string): string {
    return nope()
  }
}
export const redactBody = (_b: unknown, _p: Pseudonyms): unknown => nope()
export type CallKind = string
export interface RecordedExchange {
  source: 'recorded' | 'synthetic'
  kind: CallKind
  request: { method: string; host: string; path: string; query: Array<[string, string]>; form: Record<string, string> | null }
  response: { status: number; headers: Record<string, string>; body: unknown }
}
export interface RecordingRun {
  id: string
  start: Date
}
export interface RecordingFetchDeps {
  plain: typeof fetch
  bucket: R2BucketLike
  run: RecordingRun
  clock: () => Date
  until: Date
  random: (n: number) => Uint8Array
  log: (line: string) => void
}
export const createRecordingFetch = (_d: RecordingFetchDeps): typeof fetch => nope()
export interface GoogleRecordingDeps {
  raw: string | undefined
  bucket: R2BucketLike | undefined
  clock: () => Date
  plain: typeof fetch | undefined
  random?: (n: number) => Uint8Array
  log?: (line: string) => void
}
export const googleRecording = (_d: GoogleRecordingDeps): { on: boolean; problem: RecordingSwitch['problem']; fetchFor(run: RecordingRun): typeof fetch | undefined } => nope()
