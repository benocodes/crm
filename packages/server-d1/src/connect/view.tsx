// [[UI30]] D10, [[UI254]] D9, [[UI256]]: the connect page's view layer, Preact components on `@vibase/ui` fed the `ViewModel`. Everything that came from the API or the URL is a text child (escaped by the
// runtime), never markup; a link is made only for an `https:` URL. No `style` prop anywhere: the page serves `style-src 'self'` off Clerk ([[UI256]] P3).
import type { ReactNode } from 'react'
import { Alert } from '@vibase/ui'
import { render } from 'preact'
import type { AgentRowView, ViewModel } from './types.js'

export interface Handlers {
  signIn(): void
  signOut(): void
  toggle(id: string, disabled: boolean): void
}

/**
 * A plain `<button>` in `@vibase/ui`'s button classes, not its `Button`: the E2Es select on `data-action`, which `Button` does not pass through ([[UI256]] P2).
 * The variant is the shared one (`secondary` for a row action, `primary` for the page's one call to action).
 */
function ActionButton({
  label,
  action,
  variant,
  onClick,
}: {
  label: string
  action: string
  variant: 'primary' | 'secondary'
  onClick: () => void
}) {
  return (
    <button type="button" className={`vb-button vb-button--${variant}`} data-action={action} onClick={onClick}>
      {label}
    </button>
  )
}

const Command = ({ value }: { value: string }) => <pre className="cmd">{value}</pre>

/** A link only for an `https:` URL: a profile URL is data from the Clerk SDK, and nothing else may become an `href`. */
function ProfileLink({ label, url }: { label: string; url: string }) {
  let https = false
  try {
    https = new URL(url).protocol === 'https:'
  } catch {
    https = false
  }
  return https ? (
    <a className="vb-link" href={url} rel="noopener noreferrer">
      {label}
    </a>
  ) : null
}

const Section = ({ name, title, children }: { name: string; title: string; children: ReactNode }) => (
  <section data-section={name}>
    <h2>{title}</h2>
    {children}
  </section>
)

function AgentItem({ agent, handlers }: { agent: AgentRowView; handlers: Handlers }) {
  return (
    <li className={agent.disabledAt ? 'agent disabled' : 'agent'} data-agent={agent.id}>
      <div className="agent-head">
        <strong>{agent.name}</strong>
        <span className="kind">{agent.kindLabel}</span>
      </div>
      <p className="scopes">{agent.scopes.length > 0 ? `Scopes: ${agent.scopes.join(', ')}` : 'Scopes: none'}</p>
      <p className="times">{`Created ${agent.createdAt}${agent.disabledAt ? `; disabled ${agent.disabledAt}` : ''}`}</p>
      {agent.grantCommand ? (
        <div>
          <p>It has no scopes yet. To grant some, run:</p>
          <Command value={agent.grantCommand} />
        </div>
      ) : null}
      {agent.action ? (
        <ActionButton
          label={agent.action === 'disable' ? 'Disable' : 'Enable'}
          action="toggle-agent"
          variant="secondary"
          onClick={() => handlers.toggle(agent.id, agent.action === 'disable')}
        />
      ) : null}
    </li>
  )
}

export function ConnectView({ vm, handlers }: { vm: ViewModel; handlers: Handlers }) {
  return (
    <>
      <h1>Connect to this Vibase</h1>
      {vm.message ? <Alert variant="info">{vm.message}</Alert> : null}
      {vm.showSignIn ? (
        <ActionButton label="Sign in" action="sign-in" variant="primary" onClick={() => handlers.signIn()} />
      ) : null}
      {vm.error ? <Alert variant="error">{vm.error}</Alert> : null}

      {vm.who ? (
        <Section name="who" title="Who you are">
          <p>{`${vm.who.name} (role: ${vm.who.role})`}</p>
          <p>{vm.who.scopes.length > 0 ? `Scopes: ${vm.who.scopes.join(', ')}` : 'Scopes: none'}</p>
        </Section>
      ) : null}

      {vm.connect ? (
        <>
          <Section name="connect" title="Connect an agent">
            {vm.connect.cli ? (
              <>
                <h3>Command line</h3>
                <Command value={vm.connect.cli.command} />
                <p>{vm.connect.cli.steps}</p>
              </>
            ) : null}
            <h3>API key</h3>
            <Command value={vm.connect.apiKey.command} />
            <p>{vm.connect.apiKey.note}</p>
          </Section>
          {vm.connect.mcp ? (
            <Section name="mcp" title="MCP">
              <p>Add this URL as a remote MCP server in your client; it signs in through this instance.</p>
              <Command value={vm.connect.mcp.url} />
            </Section>
          ) : null}
        </>
      ) : null}

      {vm.agents ? (
        <Section name="agents" title="Connected agents">
          <p className="note">{vm.agents.note}</p>
          <p className="note">{vm.agents.personalLoginNote}</p>
          {vm.agents.rows.length > 0 ? (
            <ul className="agents">
              {vm.agents.rows.map((row) => (
                <AgentItem key={row.id} agent={row} handlers={handlers} />
              ))}
            </ul>
          ) : (
            <p>No agents yet.</p>
          )}
        </Section>
      ) : null}

      {vm.account ? (
        <Section name="account" title="Account">
          {vm.account.profileUrl ? <ProfileLink label="Your Clerk profile" url={vm.account.profileUrl} /> : null}
          <ActionButton label="Sign out" action="sign-out" variant="secondary" onClick={() => handlers.signOut()} />
        </Section>
      ) : null}
    </>
  )
}

const mounted = new WeakSet<Element>()
/**
 * Draws the view into `root`. The first draw clears what the HTML shipped (its "Loading" placeholder): Preact appends into a non-empty container instead of replacing it,
 * which left a stray "Loading" line under a signed-in view. Later draws diff against the previous one.
 */
export function drawView(root: HTMLElement, vm: ViewModel, handlers: Handlers): void {
  if (!mounted.has(root)) {
    root.replaceChildren()
    mounted.add(root)
  }
  render(<ConnectView vm={vm} handlers={handlers} />, root)
}
