// [[UI30]] D4: the only logic the page owns. Given the session state and the API's answers, what to show. Pure: no DOM, no Clerk, no network.
import type { AgentRecord, AgentRowView, Me, PageState, ViewModel } from './types.js'

const SCOPE_READ_AGENTS = 'agents:read'
const SCOPE_WRITE_AGENTS = 'agents:write'

const EMPTY: ViewModel = { state: 'loading', message: null, showSignIn: false, who: null, connect: null, agents: null, account: null, error: null }

const apiKeyDirections = (origin: string): { command: string; note: string } => ({
  command: `printf %s "$VIBASE_API_KEY" | vibase login --api-key --server ${origin}`,
  note: 'For scripts and agents that cannot use a browser. An owner creates a key with `vibase api-keys create`; the key is read from stdin, never from the command line.',
})

function agentRow(a: AgentRecord, me: Me, canToggle: boolean): AgentRowView {
  const delegated = a.delegated_by !== null || a.auth_client_id !== null
  const kind = delegated ? 'delegated' : a.auth_subject !== null ? 'agent-account' : 'api-key'
  const kindLabel =
    kind === 'delegated'
      ? a.delegated_by === null
        ? `delegated via OAuth client ${a.auth_client_id}`
        : a.delegated_by === me.principal.id
          ? `delegated by you (${me.user?.email ?? a.delegated_by})`
          : `delegated by ${a.delegated_by}`
      : kind === 'agent-account'
        ? 'agent account'
        : 'API-key agent'
  return {
    id: a.id,
    name: a.name,
    kind,
    kindLabel,
    scopes: a.scopes,
    // [[UI30]] D12: no scope editor; an owner grants an agent account its first scopes with the CLI.
    grantCommand: canToggle && a.scopes.length === 0 ? `vibase agents update ${a.id} --scopes '["contacts:read","contacts:write"]'` : null,
    createdAt: a.created_at,
    disabledAt: a.disabled_at,
    action: canToggle ? (a.disabled_at === null ? 'disable' : 'enable') : null,
  }
}

export function buildView(state: PageState, ctx: { origin: string; mcpUrl?: string | null; profileUrl?: string | null }): ViewModel {
  const { origin } = ctx
  switch (state.kind) {
    case 'loading':
      return { ...EMPTY, state: 'loading', message: 'Loading' }
    case 'unavailable':
      return {
        ...EMPTY,
        state: 'unavailable',
        message: 'Sign-in is not configured for this instance: agents connect with API keys.',
        connect: { cli: null, apiKey: apiKeyDirections(origin), mcp: null },
      }
    case 'signed-out':
      return { ...EMPTY, state: 'signed-out', message: 'Sign in to see who you are, how to connect an agent, and which agents are connected.', showSignIn: true }
    case 'refused':
      return {
        ...EMPTY,
        state: 'refused',
        message:
          state.status === 0
            ? "Clerk's sign-in could not be loaded from this instance's Frontend API. Reload the page, or connect agents with API keys."
            : `This instance did not accept your session (${state.status}). Sign out, then sign in with an account that has access.`,
        account: { profileUrl: ctx.profileUrl ?? null },
      }
    case 'signed-in': {
      const { me } = state
      const scopes = me.active_organization?.scopes ?? []
      const canToggle = scopes.includes(SCOPE_WRITE_AGENTS)
      return {
        ...EMPTY,
        state: 'signed-in',
        who: {
          name: me.user?.email ?? me.agent?.name ?? me.principal.id,
          role: me.principal.kind === 'agent' ? 'agent' : (me.active_organization?.role ?? 'none'),
          scopes,
        },
        connect: {
          cli: {
            command: `vibase login --server ${origin}`,
            steps: 'Run this in a terminal. It prints a link: open the link in any browser, sign in, approve the connection, then return to the terminal.',
          },
          apiKey: apiKeyDirections(origin),
          mcp: ctx.mcpUrl ? { url: ctx.mcpUrl } : null,
        },
        agents:
          state.agents === null || !scopes.includes(SCOPE_READ_AGENTS)
            ? null
            : {
                rows: state.agents.map((a) => agentRow(a, me, canToggle)),
                canToggle,
                note: "An agent's access is its stored scopes, further bounded by what was approved on the consent screen and by the role of the person who delegated it.",
                personalLoginNote: 'Your own `vibase login` is you, not an agent, so it is not listed here. `vibase logout`, or signing out of all sessions in Clerk, ends it.',
              },
        account: { profileUrl: ctx.profileUrl ?? null },
        error: state.error ?? null,
      }
    }
  }
}
