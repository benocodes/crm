// The Workflow's body: read the inbound message with the example's own agent, draft a reply, propose it through the action-request rail. Node-safe (the Workflow class in
// `workflow.ts` passes Cloudflare's `step`), so the tests run it against a fake vault. Every step returns plain data ([[API7]] D21, the workerd structured-clone rule).
import { createVault, type VaultDeps } from './vault.js'

export interface StepConfigLike {
  retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }
  timeout?: string | number
}
export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>
  do<T>(name: string, config: StepConfigLike, fn: () => Promise<T>): Promise<T>
}
export type ReplyOutcome = { outcome: 'proposed'; request_id: string; created: boolean } | { outcome: 'skipped'; reason: string }

/** Each step talks to the vault, so each retries on a transport or 5xx error (the vault client ends the step at once on a refusal that cannot change). */
const VAULT_STEP: StepConfigLike = { retries: { limit: 4, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' }
/** The message content is capped so a step's result stays far below the platform's limit. */
const MAX_CONTENT_CHARS = 20_000

interface InteractionRecord {
  id: string
  kind: string
  direction: string
  thread_id: string | null
  message_id: string | null
  participants: Array<{ identity_id: string; role: string }>
}
interface MessageRecord {
  author: { user_id: string }
}
interface ConnectionRecord {
  id: string
  identity_id: string
  status: string
}
interface Page<T> {
  data: T[]
}

type Read = { skip: string } | { skip: null; thread_id: string; sender: string; content: string; recipient_identities: string[] }

/**
 * The reply text. Replace this with your own logic: it is where a model call (the Vercel AI SDK, for example) belongs. It is a pure function so the example needs no key and runs offline.
 */
export function draftReply(message: { from: string; content: string }): string {
  const asked = message.content.trim().split('\n')[0]!.slice(0, 200)
  return `Hello,\n\nThanks for your message ("${asked}"). We have received it and will reply in full shortly.\n\nBest regards`
}

export async function runReply(event: { payload: unknown }, step: StepLike, deps: VaultDeps): Promise<ReplyOutcome> {
  const vault = createVault(deps)
  const interactionId = (event.payload as { resource_id: string }).resource_id

  const read = await step.do('read-message', VAULT_STEP, async (): Promise<Read> => {
    const interaction = await vault.get<InteractionRecord>(`/api/v1/interactions/${interactionId}`)
    if (interaction.kind !== 'message' || interaction.direction !== 'inbound' || !interaction.message_id || !interaction.thread_id) return { skip: 'not_inbound_email' }
    const message = await vault.get<MessageRecord>(`/api/v1/messages/${interaction.message_id}`)
    const content = await vault.get<{ content: string }>(`/api/v1/messages/${interaction.message_id}/content`)
    return {
      skip: null,
      thread_id: interaction.thread_id,
      sender: message.author.user_id,
      content: content.content.slice(0, MAX_CONTENT_CHARS),
      recipient_identities: interaction.participants.filter((p) => p.role === 'to' || p.role === 'cc').map((p) => p.identity_id),
    }
  })
  if (read.skip !== null) return { outcome: 'skipped', reason: read.skip }

  // The mailbox that received the message is the one to answer from. If none matches (a forwarded or aliased mailbox), the only active connection is used; with several, the example does not guess.
  const connectionId = await step.do('find-connection', VAULT_STEP, async (): Promise<string | null> => {
    const active = (await vault.get<Page<ConnectionRecord>>('/meta/v1/connections?limit=200')).data.filter((c) => c.status === 'active')
    const received = active.filter((c) => read.recipient_identities.includes(c.identity_id))
    if (received.length >= 1) return received[0]!.id
    return active.length === 1 ? active[0]!.id : null
  })
  if (connectionId === null) return { outcome: 'skipped', reason: 'no_matching_connection' }

  const body = await step.do('draft-reply', async () => draftReply({ from: read.sender, content: read.content }))

  return step.do('propose-reply', VAULT_STEP, async (): Promise<ReplyOutcome> => {
    // A retried step (or a replayed event) must not propose twice: ask first, for any request about this interaction.
    const existing = (await vault.get<Page<{ id: string }>>(`/api/v1/action-requests?interaction_id=${interactionId}&operation=messages.send&limit=1`)).data[0]
    if (existing) return { outcome: 'proposed', request_id: existing.id, created: false }
    const created = await vault.post<{ id: string }>('/api/v1/action-requests', {
      operation: 'messages.send',
      arguments: { connection_id: connectionId, mode: 'reply', thread_id: read.thread_id, to: [read.sender], body },
      reason: 'Draft reply to an inbound email, proposed by the webhook example.',
      interaction_id: interactionId,
    })
    return { outcome: 'proposed', request_id: created.id, created: true }
  })
}
