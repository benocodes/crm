// Test-only: never import from non-test code. The sender suites' harness ([[API220]]): the webhook kit on a movable clock, a fake `fetch` that records each call and answers by a
// settable handler, manual timers for the 10 s attempt timeout, and the sender driven as the cron drives it.
import { sendWebhooks, type SenderDeps, type SenderSummary } from '../webhooks/sender.js'
import { KEY_BYTES, NOW, openWebhookKit, type WebhookKit } from './webhook-kit.js'

export interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  redirect: RequestRedirect | undefined
  signal: AbortSignal | undefined
  /** The fake clock (ms) when the fetch was made. */
  at: number
  /** The fetches in flight when this one started, itself included. */
  inFlight: number
}
export type Handler = (call: FetchCall) => Promise<Response> | Response

export interface SenderKit {
  k: WebhookKit
  calls: FetchCall[]
  /** The most fetches ever in flight at once. */
  maxInFlight: number
  handler: Handler
  /** `after` registrations (ms), newest last; with `autoFire` each fires on the next macrotask (the clock does not move). */
  timers: { ms: number; fired: boolean }[]
  autoFire: boolean
  now(): number
  advance(ms: number): void
  send(over?: Partial<SenderDeps>): Promise<SenderSummary>
  /** An agent that may read events and tasks, and a subscription of it to `task.created` at `url`. */
  subscribe(over?: { url?: string; scopes?: string[]; event_types?: string[] }): Promise<{ agent: string; sub: any }>
  /** A task event, dispatched: the delivery row's id. */
  due(subscriptionId: string, title?: string): Promise<{ delivery: string; event: string }>
  row(deliveryId: string): Promise<Record<string, any>>
  reset(): Promise<void>
  close(): Promise<void>
}

export const ok = (status = 200) => new Response(null, { status })
export const READ_SCOPES = ['events:read', 'tasks:read']

export async function openSenderKit(): Promise<SenderKit> {
  let now = NOW.getTime()
  const k = await openWebhookKit({ clock: () => new Date(now) })
  const s = {} as SenderKit
  let inFlight = 0
  Object.assign(s, {
    k,
    calls: [] as FetchCall[],
    maxInFlight: 0,
    handler: () => ok(200),
    timers: [] as { ms: number; fired: boolean }[],
    autoFire: false,
    now: () => now,
    advance: (ms: number) => void (now += ms),
    async send(over: Partial<SenderDeps> = {}) {
      const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
        inFlight++
        s.maxInFlight = Math.max(s.maxInFlight, inFlight)
        const call: FetchCall = {
          url,
          method: String(init.method),
          headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
          body: String(init.body),
          redirect: init.redirect,
          signal: init.signal ?? undefined,
          at: now,
          inFlight,
        }
        s.calls.push(call)
        try {
          return await s.handler(call)
        } finally {
          inFlight--
        }
      }
      const after = (ms: number, fn: () => void) => {
        const t = { ms, fired: false }
        s.timers.push(t)
        let live = true
        if (s.autoFire) setTimeout(() => live && ((t.fired = true), fn()), 0)
        return () => void (live = false)
      }
      return sendWebhooks({ ...k.deps(), fetch: fetchFn, key: KEY_BYTES, random: () => 0.5, after, ...over })
    },
    async subscribe(over: { url?: string; scopes?: string[]; event_types?: string[] } = {}) {
      const agent = await k.seedAgent(over.scopes ?? READ_SCOPES)
      const sub = await k.create(agent, { url: over.url ?? 'https://receiver.example/hook', event_types: over.event_types ?? ['task.created'] })
      return { agent, sub }
    },
    async due(subscriptionId: string, title = 'a task') {
      const event = await k.task(title)
      await k.dispatch()
      const rows = await k.all('select id from webhook_deliveries where subscription_id = ? and event_id = ?', subscriptionId, event)
      return { delivery: rows[0]!.id as string, event }
    },
    async row(deliveryId: string) {
      return (await k.all('select * from webhook_deliveries where id = ?', deliveryId))[0]!
    },
    async reset() {
      await k.reset()
      now = NOW.getTime()
      s.calls.length = 0
      s.timers.length = 0
      s.maxInFlight = 0
      s.handler = () => ok(200)
      s.autoFire = false
    },
    close: () => k.close(),
  })
  return s
}
