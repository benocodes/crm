// [[UI461]] D12 ([[UI443]]): how to connect an agent, as `CommandBlock`s. The text is `connect-text.ts`'s; every value renders as text, never markup.
import { CommandBlock } from '@vibase/ui/components'
import { apiKeyDirections, LOGIN_STEPS, loginCommand, MCP_NOTE } from './connect-text.js'

export interface ConnectAgentInstructionsProps {
  /** The page's origin: the server the commands name. */
  origin: string
  /** Sign-in is available (a provider is configured): the device login is offered. */
  signIn: boolean
  /** The MCP URL when discovery advertises one. */
  mcpUrl: string | null
}

export function ConnectAgentInstructions({ origin, signIn, mcpUrl }: ConnectAgentInstructionsProps) {
  const apiKey = apiKeyDirections(origin)
  return (
    <div className="flex flex-col gap-4">
      {signIn ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">Command line</h4>
          <CommandBlock command={loginCommand(origin)} label="login command" />
          <p className="text-sm text-muted-foreground">{LOGIN_STEPS}</p>
        </div>
      ) : null}
      {mcpUrl ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">MCP</h4>
          <CommandBlock command={mcpUrl} label="MCP URL" />
          <p className="text-sm text-muted-foreground">{MCP_NOTE}</p>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium">API key</h4>
        <CommandBlock command={apiKey.command} label="API-key command" />
        <p className="text-sm text-muted-foreground">{apiKey.note}</p>
      </div>
    </div>
  )
}
