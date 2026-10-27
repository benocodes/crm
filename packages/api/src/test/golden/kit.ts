// Test-only. What both golden backends share for the auth and directory scenarios (CORE41 P15): the fake Clerk a scenario
// loads, the authenticator that sends an alg:none token to the injected-principal stand-in and any other token to the REAL
// authenticator, and one `send` that knows every kind of actor.
import type { Hono } from 'hono'
import { createUserAuthenticator } from '../../auth/user-authenticator.js'
import type { UserAuthenticator } from '../../auth/types.js'
import { clerkWebhookHandler } from '../../directory/webhook.js'
import { createVaultRegistry } from '../../operations.js'
import { clerkMembership, clerkOrganization, clerkUser, mintClerkToken, orgClaim, signClerkWebhook, testClerkAdapter } from '../clerk.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../user-auth.js'
import { GOLDEN_AGENT_KEY, GOLDEN_EXPIRED_KEY, IDS, type GoldenActor, type GoldenClerk } from './scenarios.js'

export type GoldenClerkKit = Awaited<ReturnType<typeof testClerkAdapter>>

export const goldenClerk = (now: () => Date): Promise<GoldenClerkKit> => testClerkAdapter({ now })

/** Empties the fake Clerk and loads a scenario's users, organisations and members. */
export function loadGoldenClerk(kit: GoldenClerkKit, spec: GoldenClerk | undefined): void {
  kit.profiles.clear()
  kit.organizations.clear()
  kit.members.clear()
  kit.fetch.reset()
  for (const u of spec?.users ?? []) kit.profiles.set(u.subject, clerkUser({ id: u.subject, email: u.email, verified: u.verified ?? true, first: u.first, last: u.last }))
  for (const o of spec?.organizations ?? []) {
    kit.organizations.set(o.id, clerkOrganization({ id: o.id, name: o.name }))
    kit.members.set(o.id, o.members.map(([userId, role]) => clerkMembership({ organizationId: o.id, userId, role })))
  }
}

/** An `alg: none` token is the injected-principal stand-in the older scenarios use; anything else is verified for real. */
export function goldenAuthenticator(clerk: GoldenClerkKit): UserAuthenticator {
  const real = createUserAuthenticator({ adapter: clerk.adapter, declaredScopes: createVaultRegistry().declaredScopes() })
  const fake = fakeUserAuthenticator()
  return {
    authenticate(token, req) {
      const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as { alg?: string }
      return header.alg === 'none' ? fake.authenticate(token, req) : real.authenticate(token, req)
    },
  }
}

/** `createApp` takes an authenticator OR an adapter, never both, so the golden backends mount the webhook themselves. */
export function mountGoldenWebhook(app: Hono<any>, clerk: GoldenClerkKit, deps: { clock: () => Date; newId: () => string }): void {
  app.post('/webhooks/clerk', clerkWebhookHandler(clerk.adapter, deps))
}

let delivery = 0
export async function goldenSend(
  world: { app: { request(path: string, init: RequestInit): Response | Promise<Response> }; clerk: GoldenClerkKit; scopes: readonly string[] },
  actor: GoldenActor,
  method: string,
  path: string,
  body: unknown,
  now: Date,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {}
  let payload = body === undefined || body === null ? undefined : JSON.stringify(body)
  if (actor === 'user' || actor === 'agent') {
    headers.authorization = `Bearer ${mintTestUserToken({ userId: actor === 'agent' ? IDS.agent : IDS.user, organizationId: IDS.org, scopes: [...world.scopes], kind: actor })}`
  } else if (actor === 'agent-key') headers.authorization = `Bearer ${GOLDEN_AGENT_KEY}`
  else if (actor === 'expired-key') headers.authorization = `Bearer ${GOLDEN_EXPIRED_KEY}`
  else if (actor === 'webhook') {
    const signed = signClerkWebhook(body, { id: `msg_golden_${String(++delivery).padStart(4, '0')}`, timestamp: Math.floor(now.getTime() / 1000) })
    Object.assign(headers, signed.headers)
    payload = signed.body
  } else {
    headers.authorization = `Bearer ${await mintClerkToken(world.clerk.issuer, { sub: actor.clerk, now, ...(actor.claim ? { extra: orgClaim(actor.claim.org, actor.claim.role) } : {}) })}`
  }
  const res = await world.app.request(path, { method, headers, body: payload })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : JSON.parse(text) }
}
