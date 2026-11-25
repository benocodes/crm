// The approvals page. Everything agent-supplied reaches the DOM through textContent only, never innerHTML.
import { createApi, ApiFailure, type Api } from './api.js'
import type { AppConfig } from './config.js'
import {
  byCreatedDesc,
  effectiveArguments,
  emailPreview,
  isExpired,
  operationTitle,
  prettyJson,
  proposerLine,
  relativeTime,
  withFullArguments,
  type ActionRequest,
} from './format.js'
import { stripInvisible } from './invisible.js'
import { providerModules, type Provider } from './providers.js'
import type { Env, ProviderModule, Session } from './session.js'

type Tab = 'pending' | 'executed' | 'failed' | 'rejected'
const TABS: Tab[] = ['pending', 'executed', 'failed', 'rejected']
const POLL_MS = 30_000
/** A reason longer than this (or with more lines) is clamped behind a Show more control. */
const CLAMP_CHARS = 240
const CLAMP_LINES = 4

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props.class) el.className = props.class
  if (props.text !== undefined) el.textContent = props.text
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v)
  el.append(...kids)
  return el
}

export interface Deps extends Env {
  config: AppConfig
  /** The provider modules (a test swaps them); the default loads each behind its own dynamic import. */
  modules?: Record<Provider, () => Promise<ProviderModule>>
}

/** The sign-in provider the instance reports, from its discovery document (uncredentialed). Anything but a known provider is an error ([[UI388]] P1). */
async function discover(config: AppConfig, fetchImpl: typeof fetch): Promise<Provider> {
  let res: Response
  try {
    res = await fetchImpl(`${config.apiOrigin}/.well-known/vibase`, { credentials: 'omit' })
  } catch {
    throw new Error('Vibase could not be reached.')
  }
  if (!res.ok) throw new Error(`Vibase discovery answered ${res.status}.`)
  const doc = (await res.json().catch(() => null)) as { auth?: { provider?: unknown } | null } | null
  const provider = doc?.auth?.provider
  if (provider === 'clerk' || provider === 'better-auth') return provider
  throw new Error('this Vibase reports no supported sign-in provider.')
}

export async function run(root: HTMLElement, deps: Deps): Promise<void> {
  let session: Session
  try {
    const provider = await discover(deps.config, deps.fetch)
    const mod = await (deps.modules ?? providerModules)[provider]()
    session = await mod.loadSession(deps.config, { fetch: deps.fetch, location: deps.location })
  } catch (e) {
    root.replaceChildren(h('p', { class: 'error', text: `Sign-in is unavailable: ${(e as Error).message}` }))
    return
  }
  if (!session.signedIn) {
    root.replaceChildren(
      h('h1', { text: 'Approvals' }),
      h('p', { text: 'Sign in to review what your agents have proposed.' }),
    )
    const b = h('button', { class: 'primary', text: 'Sign in' })
    b.addEventListener('click', () => void session.signIn())
    root.append(b)
    return
  }
  const api = createApi(deps.config.apiOrigin, () => session.token(), deps.fetch)
  new Page(root, session, api).start()
}

class Page {
  private tab: Tab = 'pending'
  private items: ActionRequest[] = []
  private error: string | null = null
  private loading = true
  private busy = new Set<string>()
  private open = new Set<string>()
  private expanded = new Set<string>()
  private notes = new Map<string, string>()
  /** Full records of messages.send requests (body text included), by id; a body never changes under its request. */
  private full = new Map<string, ActionRequest>()
  private timer: number | undefined

  constructor(
    private root: HTMLElement,
    private session: Session,
    private api: Api,
  ) {}

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
      this.items = (await this.hydrate(await this.api.list(this.tab))).sort(byCreatedDesc)
      this.error = null
    } catch (e) {
      this.error = this.describe(e)
      if (e instanceof ApiFailure && e.status === 401) window.clearInterval(this.timer)
    }
    this.loading = false
    this.draw()
  }

  /** The list returns only a descriptor for a message body; read the full record once per send request. A failed read leaves the descriptor, and the card says so. */
  private async hydrate(listed: ActionRequest[]): Promise<ActionRequest[]> {
    const missing = listed.filter((r) => r.operation === 'messages.send' && !this.full.has(r.id))
    await Promise.all(
      missing.map(async (r) => {
        try {
          this.full.set(r.id, await this.api.get(r.id))
        } catch {
          /* shown as "Message text unavailable" */
        }
      }),
    )
    return listed.map((r) => (this.full.has(r.id) ? withFullArguments(r, this.full.get(r.id)!) : r))
  }

  private describe(e: unknown): string {
    if (e instanceof ApiFailure) {
      if (e.status === 403)
        return `Not allowed: ${e.message}. This account needs the action_requests read scope (and the target's write scope to approve).`
      return e.message
    }
    // A CORS or network failure is a TypeError with no detail.
    return 'Vibase could not be reached.'
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

  /** A failed sign-out stays on the page with an error (the person is still signed in); the next successful action clears it. */
  private async signOut(): Promise<void> {
    try {
      await this.session.signOut()
    } catch {
      this.error = 'Could not sign out. You are still signed in; try again.'
      this.draw()
    }
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
    out.addEventListener('click', () => void this.signOut())
    const reload = h('button', { class: 'link', text: 'Refresh' })
    reload.addEventListener('click', () => void this.refresh())
    const header = h(
      'header',
      {},
      h('h1', { text: 'Approvals' }),
      h('div', { class: 'who' }, h('span', { text: this.session.email ?? '' }), reload, out),
    )
    const body = h('section', { class: 'list' })
    if (this.error) body.append(h('p', { class: 'error', text: this.error, attrs: { role: 'alert' } }))
    if (this.loading) body.append(h('p', { class: 'muted', text: 'Loading' }))
    else if (this.items.length === 0 && !this.error)
      body.append(
        h('p', {
          class: 'muted',
          text: this.tab === 'pending' ? 'Nothing waiting for you.' : `No ${this.tab} requests.`,
        }),
      )
    for (const r of this.items) body.append(this.card(r, now))
    this.root.replaceChildren(header, tabs, body)
  }

  private email(e: NonNullable<ReturnType<typeof emailPreview>>): HTMLElement {
    const line = (label: string, values: string[]) =>
      values.length === 0
        ? []
        : [
            h(
              'div',
              { class: 'field' },
              h('span', { class: 'label', text: label }),
              h('span', { text: values.join(', ') }),
            ),
          ]
    return h(
      'div',
      { class: 'email' },
      ...line('To', e.to),
      ...line('Cc', e.cc),
      ...line('Bcc', e.bcc),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label', text: 'Subject' }),
        h('strong', { text: e.subject || '(no subject)' }),
      ),
      e.body === null
        ? h('p', { class: 'error', text: 'Message text unavailable. Do not approve what you cannot read.' })
        : h('div', { class: 'body', text: e.body }),
    )
  }

  /** The proposer's reason, labelled as theirs, with the bidi controls removed, clamped to a few lines with a control to expand when it is long. */
  private reason(r: ActionRequest): HTMLElement {
    const text = stripInvisible(r.reason)
    const long = text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES
    const body = h('p', { class: `reason-text${long && !this.expanded.has(r.id) ? ' clamped' : ''}`, text })
    const box = h(
      'div',
      { class: 'reason' },
      h('span', { class: 'label', text: "Proposer's reason (written by the proposer, not checked by the vault)" }),
      body,
    )
    if (long) {
      const toggle = h('button', { class: 'link', text: this.expanded.has(r.id) ? 'Show less' : 'Show more' })
      toggle.addEventListener('click', () => {
        const open = !this.expanded.has(r.id)
        if (open) this.expanded.add(r.id)
        else this.expanded.delete(r.id)
        body.classList.toggle('clamped', !open)
        toggle.textContent = open ? 'Show less' : 'Show more'
      })
      box.append(toggle)
    }
    return box
  }

  private card(r: ActionRequest, now: number): HTMLElement {
    const pending = r.status === 'pending'
    const expired = pending && isExpired(r, now)
    const meta = pending
      ? `proposed ${relativeTime(r.created_at, now)} · ${expired ? 'expired' : `expires ${relativeTime(r.expires_at, now)}`}`
      : `${r.status}${r.decided_at ? ` ${relativeTime(r.decided_at, now)}` : ''}`
    const card = h(
      'article',
      { class: 'card' },
      // [[AGT588]] D12: the vault's words lead (its summary, else the operation), then who proposed it and from which mailbox; the proposer's own text follows, labelled.
      h(
        'div',
        { class: 'row' },
        h('h2', { text: r.target_summary ? stripInvisible(r.target_summary) : operationTitle(r.operation) }),
        h('code', { text: r.operation }),
      ),
    )
    const proposer = proposerLine(r)
    if (proposer) card.append(h('p', { class: 'proposer', text: stripInvisible(proposer) }))
    if (r.sending_mailbox)
      card.append(h('p', { class: 'mailbox', text: `Sends from ${stripInvisible(r.sending_mailbox)}` }))
    card.append(this.reason(r), h('p', { class: 'muted', text: meta }))
    const email = emailPreview(r)
    if (email) card.append(this.email(email))
    const details = h(
      'details',
      {},
      h('summary', { text: email ? 'Raw arguments' : 'Arguments' }),
      h('pre', { text: prettyJson(effectiveArguments(r)) }),
    )
    if (this.open.has(r.id)) details.open = true
    details.addEventListener('toggle', () => (details.open ? this.open.add(r.id) : this.open.delete(r.id)))
    card.append(details)
    if (r.evidence.length > 0)
      card.append(
        h('p', { class: 'muted', text: `Evidence: ${r.evidence.map((e) => `${e.type} ${e.id}`).join(', ')}` }),
      )
    if (r.decision_reason) card.append(h('p', { class: 'muted', text: `Decision note: ${r.decision_reason}` }))
    if (r.error_message) card.append(h('p', { class: 'error', text: `${r.error_code ?? 'error'}: ${r.error_message}` }))
    if (pending && !expired) {
      const note = h('input', {
        attrs: { type: 'text', placeholder: 'Note (optional)', 'aria-label': 'Decision note', maxlength: '2000' },
      })
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
