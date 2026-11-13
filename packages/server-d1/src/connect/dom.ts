// [[UI30]] D10: the DOM layer. Everything that came from the API or the URL is set with `textContent` (or a vetted attribute), never as markup.
import type { AgentRowView, ViewModel } from './types.js'

export interface Handlers {
  signIn(): void
  signOut(): void
  toggle(id: string, disabled: boolean): void
}

type Child = Node | string | null | undefined | false

function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    node.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}
const text = (tag: string, value: string, cls?: string): HTMLElement => {
  const node = el(tag, cls ? { class: cls } : {})
  node.textContent = value
  return node
}
const code = (value: string): HTMLElement => text('pre', value, 'cmd')
const button = (label: string, action: string, onClick: () => void, extra: Record<string, string> = {}): HTMLButtonElement => {
  const b = el('button', { type: 'button', 'data-action': action, ...extra }) as HTMLButtonElement
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}
/** A link only for an `https:` URL: a profile URL is data from the Clerk SDK, and nothing else may become an `href`. */
function safeLink(label: string, url: string): HTMLElement | null {
  try {
    return new URL(url).protocol === 'https:' ? Object.assign(el('a', { href: url, rel: 'noopener noreferrer' }), { textContent: label }) : null
  } catch {
    return null
  }
}
const section = (name: string, title: string, ...body: Child[]): HTMLElement => el('section', { 'data-section': name }, text('h2', title), ...body)

function agentItem(a: AgentRowView, handlers: Handlers): HTMLElement {
  return el(
    'li',
    { class: a.disabledAt ? 'agent disabled' : 'agent', 'data-agent': a.id },
    el('div', { class: 'agent-head' }, text('strong', a.name), text('span', a.kindLabel, 'kind')),
    text('p', a.scopes.length > 0 ? `Scopes: ${a.scopes.join(', ')}` : 'Scopes: none', 'scopes'),
    text('p', `Created ${a.createdAt}${a.disabledAt ? `; disabled ${a.disabledAt}` : ''}`, 'times'),
    a.grantCommand ? el('div', {}, text('p', 'It has no scopes yet. To grant some, run:'), code(a.grantCommand)) : null,
    a.action ? button(a.action === 'disable' ? 'Disable' : 'Enable', 'toggle-agent', () => handlers.toggle(a.id, a.action === 'disable')) : null,
  )
}

export function render(root: HTMLElement, vm: ViewModel, handlers: Handlers): void {
  const parts: Node[] = [text('h1', 'Connect to this Vibase')]
  if (vm.message) parts.push(text('p', vm.message, 'message'))
  if (vm.showSignIn) parts.push(button('Sign in', 'sign-in', () => handlers.signIn()))
  if (vm.error) parts.push(text('p', vm.error, 'error'))

  if (vm.who) {
    parts.push(section('who', 'Who you are', text('p', `${vm.who.name} (role: ${vm.who.role})`), text('p', vm.who.scopes.length > 0 ? `Scopes: ${vm.who.scopes.join(', ')}` : 'Scopes: none')))
  }

  if (vm.connect) {
    const c = vm.connect
    const body: Child[] = []
    if (c.cli) body.push(text('h3', 'Command line'), code(c.cli.command), text('p', c.cli.steps))
    body.push(text('h3', 'API key'), code(c.apiKey.command), text('p', c.apiKey.note))
    parts.push(section('connect', 'Connect an agent', ...body))
    if (c.mcp) parts.push(section('mcp', 'MCP', text('p', 'Add this URL as a remote MCP server in your client; it signs in through this instance.'), code(c.mcp.url)))
  }

  if (vm.agents) {
    const a = vm.agents
    parts.push(
      section(
        'agents',
        'Connected agents',
        text('p', a.note, 'note'),
        text('p', a.personalLoginNote, 'note'),
        a.rows.length > 0 ? el('ul', { class: 'agents' }, ...a.rows.map((r) => agentItem(r, handlers))) : text('p', 'No agents yet.'),
      ),
    )
  }

  if (vm.account) {
    const link = vm.account.profileUrl ? safeLink('Your Clerk profile', vm.account.profileUrl) : null
    parts.push(section('account', 'Account', link, button('Sign out', 'sign-out', () => handlers.signOut())))
  }

  root.replaceChildren(...parts)
}
