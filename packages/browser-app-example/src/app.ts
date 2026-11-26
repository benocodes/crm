// The page (DX637 D11): signs a person in with @vibase/sdk's browserSignIn(), shows who they are and their first contacts, refreshes and signs out.
// Every browser seam is injected (fetch, location, navigate, replaceUrl, sessionStorage) so a test drives it with fakes (main.ts wires the real ones).
import { browserSignIn, createClient, type StorageLike } from '@vibase/sdk'
import type { AppConfig } from './settings.js'

export interface RunOptions {
  config: AppConfig
  fetch: typeof fetch
  location: { href: string; origin: string }
  navigate?: (url: string) => void
  replaceUrl?: (url: string) => void
  sessionStorage?: StorageLike
}

/** The callback path the example is registered with (README step 1); the static host serves index.html for it. */
export const CALLBACK_PATH = '/callback'

interface Me {
  principal: { kind: string }
  user: { email: string; name: string | null } | null
  agent: { name: string } | null
}
interface Contact {
  id: string
  name: string
}

const describe = (e: unknown): { status: number; code: string; message: string } => {
  const x = (e ?? {}) as { status?: unknown; code?: unknown; message?: unknown }
  return {
    status: typeof x.status === 'number' ? x.status : 0,
    code: typeof x.code === 'string' ? x.code : 'error',
    message: typeof x.message === 'string' ? x.message : String(e),
  }
}

/**
 * The token record lives in the app's own store, a thin wrapper over sessionStorage (D6's custom store). It lets "Refresh now" mark the one
 * record it holds expired, so the next `token()` takes the SDK's refresh path without any SDK export (P2).
 */
function recordingStore(inner: StorageLike) {
  let key: string | null = null
  return {
    getItem(k: string) {
      key = k
      return inner.getItem(k)
    },
    setItem(k: string, v: string) {
      key = k
      inner.setItem(k, v)
    },
    removeItem(k: string) {
      inner.removeItem(k)
    },
    /** Rewrites `expires_at` of the held record to the past; false when there is none. */
    expire(): boolean {
      const raw = key === null ? null : inner.getItem(key)
      if (key === null || raw === null) return false
      inner.setItem(key, JSON.stringify({ ...JSON.parse(raw), expires_at: 0 }))
      return true
    },
  }
}

export async function run(root: HTMLElement, options: RunOptions): Promise<void> {
  const { config, location } = options
  const sessionStore = options.sessionStorage ?? globalThis.sessionStorage
  const store = recordingStore(sessionStore)
  const signIn = browserSignIn({
    url: config.vibaseUrl,
    clientId: config.clientId,
    redirectUri: `${location.origin}${CALLBACK_PATH}`,
    // No scopes: the instance's default set applies (P5).
    storage: store,
    fetch: options.fetch,
    location,
    ...(options.navigate ? { navigate: options.navigate } : {}),
    ...(options.replaceUrl ? { replaceUrl: options.replaceUrl } : {}),
    sessionStorage: sessionStore,
  })
  const vibase = createClient({ url: config.vibaseUrl, auth: signIn.token, fetch: options.fetch })
  const replaceUrl = options.replaceUrl ?? ((u: string) => history.replaceState(null, '', u))

  let notice: string | null = null
  let me: Me | null = null
  let contacts: Contact[] = []

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const e = document.createElement(tag)
    if (text !== undefined) e.textContent = text
    return e
  }
  const button = (label: string, onClick: () => void) => {
    const b = el('button', label)
    b.type = 'button'
    b.addEventListener('click', onClick)
    return b
  }

  function render() {
    const view: HTMLElement[] = [el('h1', 'Vibase browser app example')]
    if (notice) view.push(Object.assign(el('p', notice), { className: 'notice' }))
    if (!signIn.isSignedIn()) {
      view.push(el('p', 'You are signed out.'), button('Sign in', onSignIn))
    } else {
      const who = me ? (me.user?.email ?? me.agent?.name ?? '') : ''
      view.push(el('p', me ? `Signed in as ${who} (principal: ${me.principal.kind})` : 'Signed in.'))
      const list = el('ul')
      for (const c of contacts) list.append(el('li', c.name))
      view.push(el('h2', 'Contacts'), list, button('Refresh now', onRefresh), button('Sign out', onSignOut))
    }
    root.replaceChildren(...view)
  }

  /** Loads who and the first contacts. A 401 (including no_credential) means the deployment ended the grant: sign out (P1). Anything else stays inline. */
  async function load() {
    notice = null
    const problems: string[] = []
    let unauthorized = false
    const attempt = async <T>(call: () => Promise<T>): Promise<T | null> => {
      try {
        return await call()
      } catch (e) {
        const d = describe(e)
        if (d.status === 401) unauthorized = true
        else problems.push(`${d.code}: ${d.message}`)
        return null
      }
    }
    const [m, page] = await Promise.all([
      attempt(() => vibase.me.get() as Promise<Me>),
      attempt(() => vibase.contacts.list({ limit: 10 }) as Promise<{ data: Contact[] }>),
    ])
    if (unauthorized) {
      signIn.signOut()
      me = null
      contacts = []
      notice = 'The deployment signed the app out. Sign in again.'
    } else {
      if (m) me = m
      if (page) contacts = page.data
      if (problems.length) notice = problems.join('; ')
    }
    render()
  }

  async function onRefresh() {
    // Learn the record's key (a read), then mark it expired: the next token() refreshes.
    signIn.isSignedIn()
    store.expire()
    await load()
  }
  function onSignOut() {
    signIn.signOut()
    me = null
    contacts = []
    notice = null
    render()
  }
  function onSignIn() {
    notice = null
    render()
    signIn.signIn().catch((e) => {
      notice = `${describe(e).code}: ${describe(e).message}`
      render()
    })
  }

  try {
    const done = await signIn.handleRedirect()
    if (done) replaceUrl(done.returnTo)
  } catch (e) {
    notice = `${describe(e).code}: ${describe(e).message}`
  }
  if (signIn.isSignedIn()) {
    const kept = notice
    await load()
    if (kept && !notice) notice = kept
    render()
  } else render()
}
