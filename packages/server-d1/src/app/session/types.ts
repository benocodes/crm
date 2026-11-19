// The shapes the session seam and the vault's own answers share ([[UI30]] D4, D8; moved from `src/connect/` by [[UI443]] D4). Dependency-free: no React, no Preact. Every string is data, never markup.

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
  agent: {
    id: string
    name: string
    delegated_by: string | null
    auth_client_id: string | null
    auth_subject: string | null
  } | null
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

/** [[UI459]] D6: the fields of a form (`forms.list`) the Agents page reads: its id is its agent's id. */
export interface FormRecord {
  id: string
  name: string
}

/** [[UI467]] D2: the fields of a connection record (`connections.list`) the Connected accounts page reads. */
export interface ConnectionRecord {
  id: string
  owner_id: string
  identity_id: string
  status: string
  last_synced_at?: string | null
  last_error_code?: string | null
  /** [[UI468]] D7: the capture settings, present on every record the API returns (the list's rows carry them too). */
  capture_labels?: string[]
  blocked_senders?: Array<{ kind: 'address' | 'domain'; value: string }>
  exclude_group_addresses?: boolean
  exclude_personal_domains?: boolean
  contact_creation?: 'sent' | 'sent_and_received' | 'none'
}

/** The seam over Clerk's browser SDK ([[UI30]] D4): the page logic never touches `window.Clerk`. */
export interface SessionSeam {
  /** Loads the SDK and the session. Not called when sign-in is unavailable. */
  load(): Promise<void>
  isSignedIn(): boolean
  /** A session token for one request; never cached by the page. */
  getToken(): Promise<string | null>
  /** Re-reads the session from Clerk; true while it is still active. */
  recheckSession(): Promise<boolean>
  /** Sends the person to sign in and back to `redirectUrl` (Clerk; Better Auth's `/sign-in` takes the seam's `returnPath` instead). */
  redirectToSignIn(redirectUrl: string): Promise<void>
  signOut(): Promise<void>
  /** Clerk's user-profile page, when the SDK knows it. */
  profileUrl(): string | null
}
