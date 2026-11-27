import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { okReply, startFakeClef, validAnswers } from './fake-clef.ts'
import { QUESTION_SET_VERSION, QUESTIONS } from './questions.ts'
import { EXIT, scan } from './scan.ts'
import { readStore, STORE_FILE } from './store.ts'

// OPS670 D4 to D6: the run, its store and resume, and its spend guards. A fixture tree in a temp dir and the fake server.
const TOKEN = 'tok-SECRET-0123456789'
const ENV = { CLOUDFLARE_ACCOUNT_ID: 'acct1', CLOUDFLARE_API_TOKEN: TOKEN }
const A = ["it('a1', () => {})", "it('a2', () => {})", "it('a3', () => {})"].join('\n')
const B = ["it('b1', () => {})", "it('b2', () => {})"].join('\n')

let root: string
let out: string
let fake: Awaited<ReturnType<typeof startFakeClef>>
let logs: string[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scan-run-'))
  out = join(root, '.test-scan')
  mkdirSync(join(root, 'pkg'))
  writeFileSync(join(root, 'pkg/a.test.ts'), A)
  writeFileSync(join(root, 'pkg/b.test.ts'), B)
  logs = []
})
afterEach(async () => {
  await fake?.close()
  rmSync(root, { recursive: true, force: true })
})
const FILES = ['pkg/a.test.ts', 'pkg/b.test.ts']
const run = (extra: Record<string, unknown> = {}) =>
  scan({
    root,
    outDir: out,
    files: FILES,
    env: ENV,
    baseUrl: fake?.baseUrl,
    sleep: async () => {},
    maxRetries: 1,
    log: (l) => void logs.push(l),
    ...extra,
  })
const caseOf = (req: { body: { state?: any } }) => String(req.body.state?.case ?? '')

describe('environment (D4)', () => {
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
    it(`refuses before any request when ${name} is missing, naming it`, async () => {
      fake = await startFakeClef()
      const env: Record<string, string | undefined> = { ...ENV }
      delete env[name]
      const r = await run({ env })
      expect(r.exitCode).toBe(EXIT.refused)
      expect(fake.requests).toHaveLength(0)
      expect(logs.join('\n')).toContain(name)
      expect(logs.join('\n')).not.toContain(TOKEN)
    })
  }
})

describe('concurrency and failures (D4)', () => {
  it('never runs more requests at once than the flag, and does use the room', async () => {
    fake = await startFakeClef((req) => ({ ...okReply(req), delayMs: 40 }))
    const r = await run({ concurrency: 2 })
    expect(r.summary.answered).toBe(5)
    expect(fake.state.maxConcurrent).toBe(2)
  })

  it('stores each failure kind with a reason, counts them, and leaks the token nowhere', async () => {
    fake = await startFakeClef((req) => {
      const c = caseOf(req)
      if (c.includes('a1')) return { status: 400, rawBody: `rejected, Authorization: Bearer ${TOKEN}` }
      if (c.includes('a2')) return { status: 503, body: {} }
      if (c.includes('a3')) {
        const answers = validAnswers(req.body.questions ?? {})
        delete answers.k1_refusal
        return { body: { result: { model: 'clef', answers, usage: { input_tokens: 3, output_tokens: 0 } } } }
      }
      return okReply(req)
    })
    const r = await run()
    expect(r.summary).toMatchObject({ cases: 5, answered: 2, failed: 3 })
    expect(r.exitCode).toBe(EXIT.failed)
    const records = readStore(out)
    expect(records).toHaveLength(5)
    const failed = records.filter((x) => x.status === 'failed')
    expect(failed).toHaveLength(3)
    for (const f of failed) expect(f.reason).toMatch(/\S/)
    expect(failed.find((f) => f.id.endsWith('a3'))?.reason).toContain('k1_refusal')
    const everything = [logs.join('\n'), readFileSync(join(out, STORE_FILE), 'utf8'), JSON.stringify(r)].join('\n')
    expect(everything).not.toContain(TOKEN)
  })
})

describe('store and resume (D5)', () => {
  it('sends only the missing cases after a part-way run', async () => {
    fake = await startFakeClef()
    await run({ limit: 2 })
    expect(fake.requests).toHaveLength(2)
    const r = await run()
    expect(fake.requests).toHaveLength(5)
    expect(r.summary).toMatchObject({ cases: 5, sent: 3, skipped: 2, answered: 3 })
  })

  it('a rerun with nothing changed sends nothing and reports every case skipped', async () => {
    fake = await startFakeClef()
    await run()
    const n = fake.requests.length
    const r = await run()
    expect(fake.requests).toHaveLength(n)
    expect(r.summary).toMatchObject({ sent: 0, skipped: 5 })
    expect(r.exitCode).toBe(EXIT.ok)
  })

  it('sends an edited case again and not the untouched ones', async () => {
    fake = await startFakeClef()
    await run()
    writeFileSync(join(root, 'pkg/a.test.ts'), A.replace("it('a2', () => {})", "it('a2', () => { expect(1).toBe(1) })"))
    const before = fake.requests.length
    const r = await run()
    expect(fake.requests.length - before).toBe(1)
    expect(caseOf(fake.requests.at(-1) as never)).toContain('a2')
    expect(r.summary).toMatchObject({ sent: 1, skipped: 4 })
  })

  it('a new question-set version asks everything again', async () => {
    fake = await startFakeClef()
    await run()
    const r = await run({ questionSet: { version: `${QUESTION_SET_VERSION}-next`, questions: QUESTIONS } })
    expect(r.summary).toMatchObject({ sent: 5, skipped: 0 })
  })

  it('retries a failed case on the next run', async () => {
    let failA1 = true
    fake = await startFakeClef((req) =>
      failA1 && caseOf(req).includes('a1') ? { status: 400, body: {} } : okReply(req),
    )
    await run()
    failA1 = false
    const before = fake.requests.length
    const r = await run()
    expect(fake.requests.length - before).toBe(1)
    expect(r.summary).toMatchObject({ sent: 1, answered: 1, failed: 0, skipped: 4 })
  })

  it('reads a store with a torn last line without losing earlier records, and appends cleanly after it', async () => {
    fake = await startFakeClef()
    await run({ limit: 2 })
    appendFileSync(join(out, STORE_FILE), '{"id":"pkg/b.test.ts > b1","file":"pkg/b.te')
    expect(readStore(out)).toHaveLength(2)
    const r = await run()
    expect(r.summary).toMatchObject({ skipped: 2, sent: 3 })
    expect(readStore(out)).toHaveLength(5)
    expect(readStore(out).filter((x) => x.status === 'answered')).toHaveLength(5)
  })

  it('a summary that matches what the server saw', async () => {
    fake = await startFakeClef((req) => (caseOf(req).includes('b2') ? { status: 400, body: {} } : okReply(req, 40)))
    const r = await run()
    expect(r.summary.sent).toBe(fake.requests.length)
    expect(r.summary.sent).toBe(r.summary.answered + r.summary.failed)
    expect(r.summary.input_tokens).toBe(40 * 4)
    expect(logs.join('\n')).toMatch(/sent\D+5/)
  })

  it('counts unparsed and empty files and truncated cases without stopping', async () => {
    fake = await startFakeClef()
    writeFileSync(join(root, 'pkg/bad.test.ts'), "it('x', () => {")
    writeFileSync(join(root, 'pkg/none.test.ts'), 'export const x = 1')
    const r = await run({ files: [...FILES, 'pkg/bad.test.ts', 'pkg/none.test.ts'], maxStateChars: 80 })
    expect(r.summary).toMatchObject({ files: 4, cases: 5, unparsed: 1, empty: 1 })
    expect(r.summary.truncated).toBe(5)
  })
})

describe('spend guards (D6)', () => {
  it('--dry-run reaches the server zero times and prints the case count and an estimate', async () => {
    fake = await startFakeClef()
    const r = await run({ dryRun: true, env: {} })
    expect(fake.requests).toHaveLength(0)
    expect(r.exitCode).toBe(EXIT.ok)
    const text = logs.join('\n')
    expect(text).toMatch(/\b5 cases\b/)
    expect(text).toMatch(/estimated.*tokens/i)
    expect(text).toMatch(/\$\d/)
  })

  it('--limit sends only that many cases', async () => {
    fake = await startFakeClef()
    const r = await run({ limit: 3 })
    expect(fake.requests).toHaveLength(3)
    expect(r.summary.cases).toBe(3)
  })

  it('the path filter sends only the cases under the path', async () => {
    fake = await startFakeClef()
    await run({ paths: ['pkg/b'] })
    expect(fake.requests.map(caseOf).every((c) => c.includes('b'))).toBe(true)
    expect(fake.requests).toHaveLength(2)
  })

  it('stops sending when usage passes the ceiling, exits non-zero, keeps the records, and resumes after', async () => {
    fake = await startFakeClef((req) => okReply(req, 100))
    const r = await run({ concurrency: 1, maxInputTokens: 250 })
    expect(fake.requests).toHaveLength(3)
    expect(r.exitCode).toBe(EXIT.ceiling)
    expect(logs.join('\n')).toMatch(/ceiling/i)
    expect(readStore(out).filter((x) => x.status === 'answered')).toHaveLength(3)
    const again = await run({ concurrency: 1, maxInputTokens: 10_000 })
    expect(again.summary).toMatchObject({ skipped: 3, sent: 2 })
    expect(again.exitCode).toBe(EXIT.ok)
  })
})
