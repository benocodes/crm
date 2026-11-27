// The Clef client (OPS670 D4): plain fetch, one request per case, credentials supplied by the caller.
// Docs: https://developers.cloudflare.com/workers-ai/models/clef/ (schema-input.json, schema-output.json).
import type { ChoiceQuestion, Question } from './questions.ts'

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

export const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4'
export const DEFAULT_MAX_RETRIES = 3
const BACKOFF_MS = 500

export const redact = (text: string, token: string): string => (token ? text.split(token).join('[redacted]') : text)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isProb = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

// An answer with a missing question or the wrong type for one is a failure, never an answered case. Returns the reason.
export function validateAnswers(answers: unknown, questions: Record<string, Question>): string | undefined {
  if (!isObject(answers)) return 'the response has no answers object'
  for (const [key, q] of Object.entries(questions)) {
    const a = answers[key]
    if (a === undefined) return `the answer to ${key} is missing`
    if (!isObject(a)) return `the answer to ${key} is not an object`
    if (a.type !== undefined && a.type !== q.type)
      return `the answer to ${key} has type ${String(a.type)}, expected ${q.type}`
    if (q.type === 'noul') {
      if (!isProb(a.noul)) return `the answer to ${key} has no noul probability between 0 and 1`
      continue
    }
    if (!isObject(a.probabilities)) return `the answer to ${key} has no probabilities`
    if (q.type === 'choice') {
      const options = Object.keys((q as ChoiceQuestion).criteria)
      if (typeof a.choice !== 'string' || !options.includes(a.choice))
        return `the answer to ${key} chose a value that is not an option`
      for (const o of options)
        if (!isProb(a.probabilities[o])) return `the answer to ${key} has no probability for option ${o}`
    } else if (typeof a.score !== 'number' || !Number.isFinite(a.score))
      return `the answer to ${key} has no numeric score`
  }
  return undefined
}

const retryable = (status: number) => status === 429 || status >= 500

export async function askClef(
  state: unknown,
  questions: Record<string, Question>,
  opts: ClefOptions,
): Promise<ClefOutcome> {
  const doFetch = opts.fetch ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const url = `${opts.baseUrl ?? DEFAULT_BASE_URL}/accounts/${opts.accountId}/ai/run/@cf/cloudflare/clef`
  const body = JSON.stringify({ model: 'clef', state, questions })
  const clean = (t: string) => redact(t, opts.token).slice(0, 300)

  let reason = 'no attempt made'
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS * 2 ** (attempt - 1))
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body,
      })
    } catch (e) {
      reason = clean(`request failed: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      reason = clean(`HTTP ${res.status}: ${text}`)
      if (retryable(res.status)) continue
      return { ok: false, reason }
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'the response is not JSON' }
    }
    // The REST envelope is not documented: accept {result: {...}} (the Workers AI convention) and the bare object.
    const payload = isObject(json) && isObject(json.result) ? json.result : json
    const answers = isObject(payload) ? payload.answers : undefined
    const problem = validateAnswers(answers, questions)
    if (problem) return { ok: false, reason: problem }
    const usage = isObject(payload) && isObject(payload.usage) ? payload.usage : {}
    return {
      ok: true,
      answers: answers as Record<string, unknown>,
      usage: {
        input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      },
    }
  }
  return { ok: false, reason: `gave up after ${maxRetries + 1} attempts: ${reason}` }
}
