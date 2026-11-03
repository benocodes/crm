// The shapes the connect page reads ([[UI30]] D4, D8). They mirror the vault's own answers (`me.get`, `agents.list`, `/.well-known/vibase`);
// the page trusts none of them as markup (D10): every string is rendered as text.

/** `GET /.well-known/vibase` (the fields the page reads). */
export interface Discovery {
  api?: string
  /** The MCP endpoint, once the MCP adapter advertises one ([[API106]] D17); absent until then. */
  mcp?: string
  auth: {
    provider: string
    issuer: string
    cli_client_id: string | null
    publishable_key: string | null
  } | null
}

export interface Me {
  principal: { id: string; kind: 'user' | 'agent' }
  user: { id: string; email: string; name: string | null; email_verified: boolean } | null
  agent: { id: string; name: string; delegated_by: string | null; auth_client_id: string | null; auth_subject: string | null } | null
  client_id: string | null
  memberships: { organization_id: string; organization_name: string; role: 'owner' | 'member' }[]
  active_organization: { id: string; role: 'owner' | 'member' | null; scopes: string[] } | null
}

export interface AgentRecord {
  id: string
  name: string
  scopes: string[]
  disabled_at: string | null
  created_at: string
  auth_subject: string | null
  auth_client_id: string | null
  delegated_by: string | null
}

/** The seam over Clerk's browser SDK ([[UI30]] D4): the page logic never touches `window.Clerk`. */
export interface ClerkLike {
  /** Loads the SDK and the session. Not called when sign-in is unavailable. */
  load(): Promise<void>
  isSignedIn(): boolean
  /** A session token for one request; never cached by the page. */
  getToken(): Promise<string | null>
  /** Re-reads the session from Clerk; true while it is still active. */
  recheckSession(): Promise<boolean>
  /** Sends the person to the sign-in page (Account Portal) and back to `redirectUrl`. */
  redirectToSignIn(redirectUrl: string): Promise<void>
  signOut(): Promise<void>
  /** Clerk's user-profile page, when the SDK knows it. */
  profileUrl(): string | null
}

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
