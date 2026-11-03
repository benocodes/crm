// [[UI30]] D1-D13: the connect page's entry. Reads the instance's discovery document, builds the Clerk seam and the API client, and draws.
import { createApi } from './api.js'
import { windowClerk } from './clerk-window.js'
import { createPage } from './controller.js'
import { render } from './dom.js'
import type { ClerkLike, Discovery } from './types.js'
import { buildView } from './view-model.js'

async function main(): Promise<void> {
  const root = document.getElementById('app')
  if (!root) return
  const origin = location.origin
  let discovery: Discovery
  try {
    const res = await fetch('/.well-known/vibase', { credentials: 'omit' })
    if (!res.ok) throw new Error(String(res.status))
    discovery = (await res.json()) as Discovery
  } catch {
    render(root, { ...buildView({ kind: 'unavailable' }, { origin }), message: "This instance's configuration could not be read, so sign-in is unavailable." }, { signIn() {}, signOut() {}, toggle() {} })
    return
  }
  // Without a publishable key no Clerk script is ever requested (D5): the page gets an inert `ClerkLike`.
  const clerk: ClerkLike = discovery.auth?.publishable_key
    ? windowClerk(discovery.auth)
    : { load: async () => {}, isSignedIn: () => false, getToken: async () => null, recheckSession: async () => false, redirectToSignIn: async () => {}, signOut: async () => {}, profileUrl: () => null }
  const api = createApi({ origin, getToken: () => clerk.getToken(), fetch: (input, init) => fetch(input, init) })
  const draw = (): void => render(root, buildView(page.state(), { origin, mcpUrl: discovery.mcp ?? null, profileUrl: clerk.profileUrl() }), handlers)
  const page = createPage({ clerk, api, discovery, origin, onChange: draw })
  const handlers = {
    signIn: () => void page.signIn(),
    signOut: () => void page.signOut(),
    toggle: (id: string, disabled: boolean) => void page.setDisabled(id, disabled),
  }
  draw()
  await page.start()
}

void main()
