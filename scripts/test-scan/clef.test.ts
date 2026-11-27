import { afterEach, describe, expect, it } from 'vitest'
import { askClef, redact, validateAnswers } from './clef.ts'
import { okReply, startFakeClef, validAnswers } from './fake-clef.ts'
import { QUESTIONS } from './questions.ts'

// OPS670 D3 and D4: the request, the retries, and the answers that make a case failed. Fake server only.
const TOKEN = 'tok-SECRET-0123456789'
let fake: Awaited<ReturnType<typeof startFakeClef>>
afterEach(async () => fake?.close())
const noSleep = async () => {}
const opts = () => ({ accountId: 'acct1', token: TOKEN, baseUrl: fake.baseUrl, sleep: noSleep, maxRetries: 3 })

describe('the request (D3, D4)', () => {
  it('posts the documented shape with the bearer token', async () => {
    fake = await startFakeClef()
    const state = { path: 'a.test.ts', case: "it('x')" }
    const out = await askClef(state, QUESTIONS, opts())
    expect(out.ok).toBe(true)
    expect(fake.requests).toHaveLength(1)
    const req = fake.requests[0]
    expect(req?.method).toBe('POST')
    expect(req?.path).toBe('/client/v4/accounts/acct1/ai/run/@cf/cloudflare/clef')
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(req?.body.model).toBe('clef')
    expect(req?.body.state).toEqual(state)
    const q = req?.body.questions ?? {}
    expect(Object.keys(q)).toHaveLength(14)
    expect(Object.keys(q).sort()).toEqual(Object.keys(QUESTIONS).sort())
    expect(q.expected_source.type).toBe('choice')
    expect(Object.keys(q.expected_source.criteria)).toContain('declared_inventory')
    expect(q.r1_inventory_breaks_it.type).toBe('noul')
    expect(q.bug_risk_if_deleted.type).toBe('score')
    expect(Array.isArray(q.bug_risk_if_deleted.criteria)).toBe(true)
  })

  it('returns the answers and usage exactly as Clef did, from the result envelope or a bare object', async () => {
    fake = await startFakeClef()
    const wrapped = await askClef('s', QUESTIONS, opts())
    expect(wrapped).toMatchObject({ ok: true, usage: { input_tokens: 100, output_tokens: 0 } })
    await fake.close()
    fake = await startFakeClef((req) => ({
      body: {
        model: 'clef',
        answers: validAnswers(req.body.questions ?? {}),
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    }))
    const bare = await askClef('s', QUESTIONS, opts())
    expect(bare).toMatchObject({ ok: true, usage: { input_tokens: 7 } })
  })
})

describe('retries and failures (D4)', () => {
  for (const status of [429, 503]) {
    it(`retries a ${status} and then succeeds`, async () => {
      const slept: number[] = []
      fake = await startFakeClef((req, n) => (n <= 2 ? { status, body: { errors: ['busy'] } } : okReply(req)))
      const out = await askClef('s', QUESTIONS, { ...opts(), sleep: async (ms) => void slept.push(ms) })
      expect(out.ok).toBe(true)
      expect(fake.requests).toHaveLength(3)
      expect(slept).toHaveLength(2)
      expect(slept[1] ?? 0).toBeGreaterThan(slept[0] ?? 0)
    })
  }

  it('stores a failure with a reason when retries are exhausted', async () => {
    fake = await startFakeClef(() => ({ status: 503, body: { errors: ['down'] } }))
    const out = await askClef('s', QUESTIONS, opts())
    expect(out).toMatchObject({ ok: false })
    expect(out.ok === false && out.reason).toMatch(/503/)
    expect(fake.requests).toHaveLength(4)
  })

  it('does not retry a 400', async () => {
    fake = await startFakeClef(() => ({ status: 400, body: { errors: [{ message: 'bad input' }] } }))
    const out = await askClef('s', QUESTIONS, opts())
    expect(out.ok === false && out.reason).toMatch(/400/)
    expect(fake.requests).toHaveLength(1)
  })

  it('fails an answer missing one question, naming it', async () => {
    fake = await startFakeClef((req) => {
      const answers = validAnswers(req.body.questions ?? {})
      delete answers.k2_names_bug
      return { body: { result: { model: 'clef', answers, usage: { input_tokens: 5, output_tokens: 0 } } } }
    })
    const out = await askClef('s', QUESTIONS, opts())
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toMatch(/k2_names_bug/)
  })

  it('fails an answer with the wrong type for its question', async () => {
    fake = await startFakeClef((req) => {
      const answers = validAnswers(req.body.questions ?? {})
      answers.r1_inventory_breaks_it = { type: 'noul', noul: 'high' }
      return { body: { result: { model: 'clef', answers, usage: { input_tokens: 5, output_tokens: 0 } } } }
    })
    const out = await askClef('s', QUESTIONS, opts())
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toMatch(/r1_inventory_breaks_it/)
  })

  it('never lets the token reach a reason, even when the server or the network echoes it', async () => {
    fake = await startFakeClef(() => ({ status: 400, rawBody: `bad Authorization: Bearer ${TOKEN}` }))
    const a = await askClef('s', QUESTIONS, opts())
    expect(JSON.stringify(a)).not.toContain(TOKEN)
    const boom = (async () => {
      throw new Error(`connect failed for Bearer ${TOKEN}`)
    }) as unknown as typeof fetch
    const b = await askClef('s', QUESTIONS, { ...opts(), fetch: boom })
    expect(b.ok).toBe(false)
    expect(JSON.stringify(b)).not.toContain(TOKEN)
  })
})

describe('validateAnswers and redact', () => {
  const good = () => validAnswers(QUESTIONS)
  it('accepts a complete well-typed answer set', () => {
    expect(validateAnswers(good(), QUESTIONS)).toBeUndefined()
  })
  const bad: [string, (a: Record<string, any>) => void][] = [
    ['a noul outside 0 to 1', (a) => (a.r2_inventory_size.noul = 1.5)],
    ['a choice that is not an option', (a) => (a.expected_source.choice = 'nonsense')],
    ['a choice without a probability for an option', (a) => delete a.exercises.probabilities.source_text],
    ['a score that is not a number', (a) => (a.bug_risk_if_deleted.score = 'high')],
    ['an answer of another type', (a) => (a.k1_refusal = a.expected_source)],
    ['a non-object answer', (a) => (a.k3_invariant = 0.3)],
  ]
  for (const [name, mutate] of bad) {
    it(`rejects ${name}`, () => {
      const a = good()
      mutate(a)
      expect(validateAnswers(a, QUESTIONS)).toMatch(/\S/)
    })
  }
  it('rejects a non-object answers value', () => {
    expect(validateAnswers(undefined, QUESTIONS)).toMatch(/\S/)
  })
  it('redacts every occurrence of the token', () => {
    expect(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a [redacted] b [redacted]')
  })
})
