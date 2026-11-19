// [[UI461]] D10, P4 ([[UI443]]), [[UI469]] D13: the Connect your email and Connect an agent checks' outcomes and what Home's Get started section shows for them. Pure: no DOM, no network (the read is injected).
import type { ApiResult } from './session/api.js'
import type { ConnectionRecord } from './session/types.js'

/** `show`: no enabled agent is known (an empty list, only disabled agents, or no `agents:read` to look). `hidden`: an enabled agent exists. `error`: the read failed. */
export type ConnectAgentCheck = { status: 'show' } | { status: 'hidden' } | { status: 'error'; message: string }
/** [[UI469]] D13: `show`: the person may connect a mailbox and owns none. `hidden`: they own one (any status) or cannot connect. `error`: the read failed. */
export type ConnectEmailCheck = ConnectAgentCheck

export const CONNECT_EMAIL_UNREADABLE = 'The mailbox list could not be read. Reload the page to try again.'

/** P3: no `connections:write` is no request and no prompt; otherwise one read of every page, where any connection the person owns (any status) hides the prompt and others' never do. */
export async function checkConnectEmail(
  scopes: readonly string[],
  userId: string,
  read: () => Promise<ApiResult<ConnectionRecord[]> | 'signed-out'>,
): Promise<ConnectEmailCheck | 'signed-out'> {
  if (!scopes.includes('connections:write')) return { status: 'hidden' }
  const unreadable: ConnectEmailCheck = { status: 'error', message: CONNECT_EMAIL_UNREADABLE }
  let r: ApiResult<ConnectionRecord[]> | 'signed-out'
  try {
    r = await read()
  } catch {
    return unreadable
  }
  if (r === 'signed-out') return r
  if (r.status < 200 || r.status >= 300 || r.body === null) return unreadable
  return { status: r.body.some((c) => c.owner_id === userId) ? 'hidden' : 'show' }
}

export interface GetStarted {
  /** The Connect your email prompt shows. */
  emailPrompt: boolean
  /** The one-line error, in place of the email prompt. */
  emailError: string | null
  /** The Connect an agent prompt shows. */
  agentPrompt: boolean
  /** The one-line error, in place of the agent prompt. */
  agentError: string | null
}

/** P5: Connect your email comes before Connect an agent; Get started renders while either check shows or errors; a failed read is never also its own prompt. */
export function getStarted(email: ConnectEmailCheck, agent: ConnectAgentCheck): GetStarted | null {
  if (email.status === 'hidden' && agent.status === 'hidden') return null
  return {
    emailPrompt: email.status === 'show',
    emailError: email.status === 'error' ? email.message : null,
    agentPrompt: agent.status === 'show',
    agentError: agent.status === 'error' ? agent.message : null,
  }
}
