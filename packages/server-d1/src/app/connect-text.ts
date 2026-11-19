// [[UI461]] D12, P3 ([[UI443]]): the one source of the connect-an-agent text. `ConnectAgentInstructions` (Home, and UI459's Agents page) renders it ([[UI476]]: the Preact connect page that imported it back is deleted). Dependency-free.
export const loginCommand = (origin: string): string => `vibase login --server ${origin}`
export const LOGIN_STEPS =
  'Run this in a terminal. It prints a link: open the link in any browser, sign in, approve the connection, then return to the terminal.'
export const apiKeyDirections = (origin: string): { command: string; note: string } => ({
  command: `printf %s "$VIBASE_API_KEY" | vibase login --api-key --server ${origin}`,
  note: 'For scripts and agents that cannot use a browser. An owner creates a key with `vibase api-keys create`; the key is read from stdin, never from the command line.',
})
export const MCP_NOTE = 'Add this URL as a remote MCP server in your client; it signs in through this instance.'
