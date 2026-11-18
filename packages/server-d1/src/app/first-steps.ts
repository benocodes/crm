// [[UI461]] D10, P4 ([[UI443]]): the Connect an agent check's outcome and what Home's Get started section shows for it. Pure: no DOM, no network.
/** `show`: no enabled agent is known (an empty list, only disabled agents, or no `agents:read` to look). `hidden`: an enabled agent exists. `error`: the read failed. */
export type ConnectAgentCheck = { status: 'show' } | { status: 'hidden' } | { status: 'error'; message: string }

export interface GetStarted {
  /** The Connect an agent prompt shows. */
  prompt: boolean
  /** The one-line error, in place of the prompt. */
  error: string | null
}

/** Get started renders only while it holds a prompt or an error; a failed read is never also the prompt. */
export function getStarted(check: ConnectAgentCheck): GetStarted | null {
  switch (check.status) {
    case 'show':
      return { prompt: true, error: null }
    case 'error':
      return { prompt: false, error: check.message }
    case 'hidden':
      return null
  }
}
