// A local stand-in for the Clef REST endpoint (OPS670): every test of the tool talks to this, never to Cloudflare.
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeRequest = {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: { model?: string; state?: any; questions?: Record<string, any> }
  raw: string
}
export type FakeReply = { status?: number; body?: unknown; delayMs?: number; rawBody?: string }
export type FakeHandler = (req: FakeRequest, n: number) => FakeReply | undefined

// A well-formed answer for every question asked, in the output types of the real schema.
export function validAnswers(questions: Record<string, any>) {
  const answers: Record<string, unknown> = {}
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'noul') answers[key] = { type: 'noul', noul: 0.1 }
    else if (q.type === 'choice') {
      const options = Object.keys(q.criteria)
      const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.6 : 0.4 / (options.length - 1)]))
      answers[key] = { type: 'choice', choice: options[0], probabilities, confidence: 0.6 }
    } else {
      const levels = q.criteria.length
      const probabilities = Object.fromEntries(q.criteria.map((_: unknown, i: number) => [String(i), 1 / levels]))
      answers[key] = { type: 'score', score: 1.5, legend: {}, probabilities, confidence: 0.2 }
    }
  }
  return answers
}

export const okReply = (req: FakeRequest, inputTokens = 100): FakeReply => ({
  body: {
    success: true,
    result: {
      model: 'clef',
      answers: validAnswers(req.body.questions ?? {}),
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  },
})

export async function startFakeClef(handler?: FakeHandler) {
  const requests: FakeRequest[] = []
  let inFlight = 0
  const state = { maxConcurrent: 0 }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {}
      const fake: FakeRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body, raw }
      requests.push(fake)
      inFlight++
      state.maxConcurrent = Math.max(state.maxConcurrent, inFlight)
      const reply = handler?.(fake, requests.length) ?? okReply(fake)
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs))
      res.statusCode = reply.status ?? 200
      res.setHeader('content-type', 'application/json')
      res.end(reply.rawBody ?? JSON.stringify(reply.body ?? {}))
      inFlight--
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/client/v4`,
    requests,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
