// [[UI461]] D10, P4 ([[UI443]]), [[UI469]] D13: the Connect your email and Connect an agent checks' outcomes and what Home's Get started section shows for them. Pure: no DOM, no network (the read is injected).
import type { ApiResult } from './session/api.js'
import type { ConnectionRecord } from './session/types.js'

/** `show`: no enabled agent is known (an empty list, only disabled agents, or no `agents:read` to look). `hidden`: an enabled agent exists. `error`: the read failed. */
export type ConnectAgentCheck = { status: 'show' } | { status: 'hidden' } | { status: 'error'; message: string }
/** [[UI469]] D13: `show`: the person may connect a mailbox and owns none. `hidden`: they own one (any status) or cannot connect. `error`: the read failed. */
export type ConnectEmailCheck = ConnectAgentCheck

export const CONNECT_EMAIL_UNREADABLE = 'The mailbox list could not be read. Reload the page to try again.'

export async function checkConnectEmail(
  _scopes: readonly string[],
  _userId: string,
  _read: () => Promise<ApiResult<ConnectionRecord[]> | 'signed-out'>,
): Promise<ConnectEmailCheck | 'signed-out'> {
  return { status: 'hidden' }
}

export interface GetStarted {
  emailPrompt: boolean
  emailError: string | null
  agentPrompt: boolean
  agentError: string | null
}

export function getStarted(_email: ConnectEmailCheck, agent: ConnectAgentCheck): GetStarted | null {
  switch (agent.status) {
    case 'show':
      return { emailPrompt: false, emailError: null, agentPrompt: true, agentError: null }
    case 'error':
      return { emailPrompt: false, emailError: null, agentPrompt: false, agentError: agent.message }
    case 'hidden':
      return null
  }
}
