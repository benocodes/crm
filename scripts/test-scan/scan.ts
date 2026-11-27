// The scan run (OPS670 D4 to D6): slice, skip what is answered, ask Clef, store each answer, summarise.
import { askClef } from './clef.ts'
import { QUESTION_SET_VERSION, QUESTIONS, type Question } from './questions.ts'
import { DEFAULT_MAX_STATE_CHARS, listTestFiles, sliceFiles } from './slice.ts'
import { answeredKeys, appendRecord, readStore, recordKey } from './store.ts'

export type ScanOptions = {
  root: string
  outDir: string
  env: Record<string, string | undefined>
  /** Path prefixes (repo-relative); a file is scanned when it starts with any of them. */
  paths?: string[]
  /** The test files to scan; default: the tracked ones. */
  files?: string[]
  limit?: number
  concurrency?: number
  maxInputTokens?: number
  maxStateChars?: number
  dryRun?: boolean
  questionSet?: { version: string; questions: Record<string, Question> }
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
export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_MAX_INPUT_TOKENS = 20_000_000
const USD_PER_MILLION_INPUT_TOKENS = 0.24
// Characters per token, for the dry run's estimate only.
const CHARS_PER_TOKEN = 4

export async function scan(opts: ScanOptions): Promise<{ exitCode: number; summary: ScanSummary }> {
  const log = opts.log ?? ((l: string) => console.log(l))
  const set = opts.questionSet ?? { version: QUESTION_SET_VERSION, questions: QUESTIONS }
  const summary: ScanSummary = {
    files: 0,
    cases: 0,
    sent: 0,
    skipped: 0,
    answered: 0,
    failed: 0,
    truncated: 0,
    unparsed: 0,
    empty: 0,
    input_tokens: 0,
  }

  const accountId = opts.env.CLOUDFLARE_ACCOUNT_ID
  const token = opts.env.CLOUDFLARE_API_TOKEN
  if (!opts.dryRun) {
    for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'] as const)
      if (!opts.env[name]) {
        log(`refused: ${name} is not set in the environment. Nothing was sent.`)
        return { exitCode: EXIT.refused, summary }
      }
  }

  let files = opts.files ?? listTestFiles(opts.root)
  if (opts.paths && opts.paths.length > 0) files = files.filter((f) => opts.paths?.some((p) => f.startsWith(p)))
  const sliced = sliceFiles(opts.root, files, { maxChars: opts.maxStateChars ?? DEFAULT_MAX_STATE_CHARS })
  let cases = sliced.cases
  if (opts.limit !== undefined) cases = cases.slice(0, opts.limit)
  summary.files = sliced.files
  summary.cases = cases.length
  summary.unparsed = sliced.unparsed.length
  summary.empty = sliced.empty.length
  summary.truncated = cases.filter((c) => c.truncated).length
  for (const u of sliced.unparsed) log(`unparsed: ${u.file} (${u.reason})`)
  for (const e of sliced.empty) log(`no cases: ${e}`)

  const done = answeredKeys(readStore(opts.outDir))
  const todo = cases.filter((c) => !done.has(recordKey(c.id, c.stateHash, set.version)))
  summary.skipped = cases.length - todo.length

  if (opts.dryRun) {
    const questionChars = JSON.stringify(set.questions).length
    const chars = todo.reduce((sum, c) => sum + JSON.stringify(c.state).length + questionChars, 0)
    const tokens = Math.ceil(chars / CHARS_PER_TOKEN)
    const usd = (tokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS
    log(
      `dry run: ${cases.length} cases in ${sliced.files} files, ${todo.length} to send, ${summary.skipped} already answered`,
    )
    log(`estimated ${tokens} input tokens, about $${usd.toFixed(2)} (no request was made)`)
    return { exitCode: EXIT.ok, summary }
  }

  const ceiling = opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  let next = 0
  let stopped = false
  const worker = async () => {
    for (;;) {
      if (stopped) return
      const c = todo[next++]
      if (!c) return
      summary.sent++
      const out = await askClef(c.state, set.questions, {
        accountId: accountId as string,
        token: token as string,
        baseUrl: opts.baseUrl,
        fetch: opts.fetch,
        sleep: opts.sleep,
        maxRetries: opts.maxRetries,
      })
      const base = {
        id: c.id,
        file: c.file,
        line: c.line,
        state_hash: c.stateHash,
        question_set_version: set.version,
        truncated: c.truncated,
        at: new Date().toISOString(),
      }
      if (out.ok) {
        summary.answered++
        summary.input_tokens += out.usage.input_tokens
        appendRecord(opts.outDir, { ...base, status: 'answered', answers: out.answers, usage: out.usage })
      } else {
        summary.failed++
        appendRecord(opts.outDir, { ...base, status: 'failed', reason: out.reason })
      }
      if (summary.input_tokens > ceiling) stopped = true
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  log(
    `summary: files ${summary.files}, cases ${summary.cases}, sent ${summary.sent}, skipped ${summary.skipped}, answered ${summary.answered}, failed ${summary.failed}, truncated ${summary.truncated}, unparsed files ${summary.unparsed}, empty files ${summary.empty}, input tokens ${summary.input_tokens}`,
  )
  if (stopped) {
    log(
      `stopped: input tokens ${summary.input_tokens} passed the ceiling of ${ceiling}. What was stored is kept; run again to continue.`,
    )
    return { exitCode: EXIT.ceiling, summary }
  }
  return { exitCode: summary.failed > 0 ? EXIT.failed : EXIT.ok, summary }
}
