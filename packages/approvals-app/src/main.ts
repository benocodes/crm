// The approvals page. Everything agent-supplied reaches the DOM through textContent only, never innerHTML.
import { createApi, ApiFailure, type Api } from './api.js'
import { loadSession, type Session } from './clerk.js'
import { byCreatedDesc, effectiveArguments, isExpired, operationTitle, prettyJson, relativeTime, type ActionRequest } from './format.js'

type Tab = 'pending' | 'executed' | 'failed' | 'rejected'
const TABS: Tab[] = ['pending', 'executed', 'failed', 'rejected']
const POLL_MS = 30_000

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props.class) el.className = props.class
  if (props.text !== undefined) el.textContent = props.text
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v)
  el.append(...kids)
  return el
}

async function main(): Promise<void> {
  const root = document.getElementById('app')!
  let session: Session
  try {
    session = await loadSession()
  } catch (e) {
    root.replaceChildren(h('p', { class: 'error', text: `Sign-in is unavailable: ${(e as Error).message}` }))
    return
  }
  if (!session.signedIn) {
    root.replaceChildren(h('h1', { text: 'Approvals' }), h('p', { text: 'Sign in to review what your agents have proposed.' }))
    const b = h('button', { class: 'primary', text: 'Sign in' })
    b.addEventListener('click', () => void session.signIn())
    root.append(b)
    return
  }
  const api = createApi(() => session.token())
  new Page(root, session, api).start()
}

class Page {
  private tab: Tab = 'pending'
  private items: ActionRequest[] = []
  private error: string | null = null
  private loading = true
  private busy = new Set<string>()
  private open = new Set<string>()
  private notes = new Map<string, string>()
  private timer: number | undefined

  constructor(private root: HTMLElement, private session: Session, private api: Api) {}

  start(): void {
    void this.refresh()
    this.timer = window.setInterval(() => void this.refresh(true), POLL_MS)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void this.refresh(true)
    })
  }

  private async refresh(quiet = false): Promise<void> {
    if (!quiet) {
      this.loading = true
      this.draw()
    }
    try {
      this.items = (await this.api.list(this.tab)).sort(byCreatedDesc)
      this.error = null
    } catch (e) {
      this.error = this.describe(e)
      if (e instanceof ApiFailure && e.status === 401) window.clearInterval(this.timer)
    }
    this.loading = false
    this.draw()
  }

  private describe(e: unknown): string {
    if (e instanceof ApiFailure) {
      if (e.status === 403) return `Not allowed: ${e.message}. This account needs the action_requests read scope (and the target's write scope to approve).`
      return e.message
    }
    // A CORS or network failure is a TypeError with no detail.
    return 'The vault could not be reached.'
  }

  private async decide(r: ActionRequest, verb: 'approve' | 'reject', reason: string): Promise<void> {
    this.busy.add(r.id)
    this.draw()
    try {
      await this.api[verb](r.id, reason.trim() || undefined)
      this.error = null
    } catch (e) {
      this.error = this.describe(e)
    }
    this.busy.delete(r.id)
    await this.refresh(true)
  }

  private draw(): void {
    const now = Date.now()
    const tabs = h('nav', { class: 'tabs' })
    for (const t of TABS) {
      const b = h('button', { class: t === this.tab ? 'tab active' : 'tab', text: t[0]!.toUpperCase() + t.slice(1) })
      b.addEventListener('click', () => {
        this.tab = t
        void this.refresh()
      })
      tabs.append(b)
    }
    const out = h('button', { class: 'link', text: 'Sign out' })
    out.addEventListener('click', () => void this.session.signOut())
    const reload = h('button', { class: 'link', text: 'Refresh' })
    reload.addEventListener('click', () => void this.refresh())
    const header = h('header', {}, h('h1', { text: 'Approvals' }), h('div', { class: 'who' }, h('span', { text: this.session.email ?? '' }), reload, out))
    const body = h('section', { class: 'list' })
    if (this.error) body.append(h('p', { class: 'error', text: this.error, attrs: { role: 'alert' } }))
    if (this.loading) body.append(h('p', { class: 'muted', text: 'Loading' }))
    else if (this.items.length === 0 && !this.error) body.append(h('p', { class: 'muted', text: this.tab === 'pending' ? 'Nothing waiting for you.' : `No ${this.tab} requests.` }))
    for (const r of this.items) body.append(this.card(r, now))
    this.root.replaceChildren(header, tabs, body)
  }

  private card(r: ActionRequest, now: number): HTMLElement {
    const pending = r.status === 'pending'
    const expired = pending && isExpired(r, now)
    const meta = pending
      ? `proposed ${relativeTime(r.created_at, now)} · ${expired ? 'expired' : `expires ${relativeTime(r.expires_at, now)}`}`
      : `${r.status}${r.decided_at ? ` ${relativeTime(r.decided_at, now)}` : ''}`
    const card = h('article', { class: 'card' }, h('div', { class: 'row' }, h('h2', { text: operationTitle(r.operation) }), h('code', { text: r.operation })), h('p', { class: 'reason', text: r.reason }), h('p', { class: 'muted', text: meta }))
    const details = h('details', {}, h('summary', { text: 'Arguments' }), h('pre', { text: prettyJson(effectiveArguments(r)) }))
    if (this.open.has(r.id)) details.open = true
    details.addEventListener('toggle', () => (details.open ? this.open.add(r.id) : this.open.delete(r.id)))
    card.append(details)
    if (r.evidence.length > 0) card.append(h('p', { class: 'muted', text: `Evidence: ${r.evidence.map((e) => `${e.type} ${e.id}`).join(', ')}` }))
    if (r.decision_reason) card.append(h('p', { class: 'muted', text: `Decision note: ${r.decision_reason}` }))
    if (r.error_message) card.append(h('p', { class: 'error', text: `${r.error_code ?? 'error'}: ${r.error_message}` }))
    if (pending && !expired) {
      const note = h('input', { attrs: { type: 'text', placeholder: 'Note (optional)', 'aria-label': 'Decision note', maxlength: '2000' } })
      note.value = this.notes.get(r.id) ?? ''
      note.addEventListener('input', () => this.notes.set(r.id, note.value))
      const mk = (verb: 'approve' | 'reject', cls: string) => {
        const b = h('button', { class: cls, text: verb === 'approve' ? 'Approve' : 'Reject' })
        b.disabled = this.busy.has(r.id)
        b.addEventListener('click', () => void this.decide(r, verb, note.value))
        return b
      }
      card.append(h('div', { class: 'actions' }, note, mk('reject', 'danger'), mk('approve', 'primary')))
    }
    return card
  }
}

void main()
