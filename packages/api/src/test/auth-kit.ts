// Test-only. A real authenticator and webhook over the fake Clerk, on either engine's binding (CORE41 P17): one
// `call` per Clerk subject, one `keyCall` per API key, a spy over the binding that records every unit it ran
// (name, identity, stats) and can arm D1's between-plan-and-commit hook for ONE named unit.
import { uuidv7, type ExecutionStats, type StorageBinding, type StorageIdentity } from '@vault/storage'
import { createApp } from '../rest/app.js'
import { internalEnv, type InternalEnv } from '../storage/internal.js'
import { clerkUser, mintClerkToken, orgClaim, signClerkWebhook, testClerkAdapter, type ClerkUserJson } from './clerk.js'
import type { Engine } from './engines.js'

export interface RanUnit {
  name: string
  identity: StorageIdentity
  stats?: ExecutionStats
}
export interface AuthKit {
  app: ReturnType<typeof createApp>
  clerk: Awaited<ReturnType<typeof testClerkAdapter>>
  /** The injected clock: assign `clock.now` to move it. Every stamp the kit's units write is this instant. */
  clock: { now: Date }
  /** The spy binding the app runs on. */
  binding: StorageBinding
  /** Every unit run through the binding, in order. */
  ran: RanUnit[]
  env(): InternalEnv
  /** D1 only: arm `hook` for the next unit with this operation name (between its plan reads and its commit batch). */
  armOn(name: string, hook: () => Promise<void>): void
  call(path: string, sub: string, init?: { method?: string; claim?: { id: string; rol: string }; body?: unknown; header?: string; iat?: Date }): Promise<Response>
  keyCall(path: string, key: string, init?: { method?: string; body?: unknown; header?: string }): Promise<Response>
  webhook(payload: unknown, opts?: { secret?: string; headers?: Record<string, string | undefined> }): Promise<Response>
  /** A Clerk profile for `sub`; returns the email. */
  profile(sub: string, opts?: { email?: string | null; verified?: boolean; first?: string | null; last?: string | null }): string | null
}

/** Build after `engine.reset()`: the D1 binding is replaced on every reset. */
export async function openAuthKit(e: Engine, opts: { now?: Date; binding?: StorageBinding } = {}): Promise<AuthKit> {
  const clock = { now: opts.now ?? new Date('2026-10-22T10:00:00.000Z') }
  const clerk = await testClerkAdapter({ now: () => clock.now })
  const real = opts.binding ?? e.binding
  const ran: RanUnit[] = []
  const armed = new Map<string, () => Promise<void>>()
  const binding = {
    ...real,
    runtime: {
      ...real.runtime,
      async execute(identity: StorageIdentity, prepared: Parameters<typeof real.runtime.execute>[1]) {
        const hook = armed.get(prepared.name)
        if (hook) {
          armed.delete(prepared.name)
          e.betweenPlanAndCommit(hook)
        }
        const entry: RanUnit = { name: prepared.name, identity }
        ran.push(entry)
        const result = await real.runtime.execute(identity, prepared)
        entry.stats = result.stats
        return result
      },
    },
  } as StorageBinding
  const app = createApp({
    authAdapter: clerk.adapter,
    storage: () => binding,
    clock: () => clock.now,
    newId: () => uuidv7(clock.now),
  })
  const request = (path: string, token: string, init: { method?: string; body?: unknown; header?: string } = {}) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.header !== undefined ? { 'x-organization-id': init.header } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  return {
    app,
    clerk,
    clock,
    binding,
    ran,
    env: () => internalEnv({ clock: () => clock.now }),
    armOn: (name, hook) => void armed.set(name, hook),
    async call(path, sub, init = {}) {
      const token = await mintClerkToken(clerk.issuer, { sub, now: init.iat ?? clock.now, ...(init.claim ? { extra: orgClaim(init.claim.id, init.claim.rol) } : {}) })
      return request(path, token, init)
    },
    keyCall: async (path, key, init) => request(path, key, init),
    async webhook(payload, o = {}) {
      const signed = signClerkWebhook(payload, { secret: o.secret, timestamp: Math.floor(clock.now.getTime() / 1000) })
      const headers: Record<string, string> = { ...signed.headers }
      for (const [name, value] of Object.entries(o.headers ?? {})) {
        if (value === undefined) delete headers[name]
        else headers[name] = value
      }
      return app.request('/webhooks/clerk', { method: 'POST', headers, body: signed.body })
    },
    profile(sub, o = {}) {
      const email = o.email === undefined ? `${sub}@x.test` : o.email
      clerk.profiles.set(sub, clerkUser({ id: sub, email, verified: o.verified ?? true, first: 'first' in o ? o.first : 'Ada', last: 'last' in o ? o.last : 'L' }))
      return email
    },
  }
}
export type { ClerkUserJson }
