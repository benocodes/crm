import type { AgentRecord, Me } from '../app/session/types.js'

// The shapes the connect page reads ([[UI30]] D4, D8). They mirror the vault's own answers (`me.get`, `agents.list`, `/.well-known/vibase`);
// the page trusts none of them as markup (D10): every string is rendered as text.

export type PageState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; me: Me; agents: AgentRecord[] | null; error?: string }
  | { kind: 'refused'; status: number }

export interface AgentRowView {
  id: string
  name: string
  kind: 'delegated' | 'agent-account' | 'api-key'
  kindLabel: string
  scopes: string[]
  /** The exact CLI line that grants an agent with no scopes its first scopes (owners only, [[UI30]] D12). */
  grantCommand: string | null
  createdAt: string
  disabledAt: string | null
  action: 'disable' | 'enable' | null
}

export interface ViewModel {
  state: PageState['kind']
  /** A line for the states with nothing else to show (loading, unavailable, refused). */
  message: string | null
  showSignIn: boolean
  who: { name: string; role: string; scopes: string[] } | null
  connect: {
    /** The device-login command; null when sign-in is unavailable. */
    cli: { command: string; steps: string } | null
    apiKey: { command: string; note: string }
    mcp: { url: string } | null
  } | null
  agents: { rows: AgentRowView[]; canToggle: boolean; note: string; personalLoginNote: string } | null
  account: { profileUrl: string | null } | null
  error: string | null
}
