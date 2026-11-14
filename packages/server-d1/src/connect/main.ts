// [[UI30]] D1-D13: the connect page's entry. Reads the instance's discovery document, builds the Clerk seam and the API client, and draws.
import { createApi } from './api.js'
import { createPage } from './controller.js'
import { render } from './dom.js'
import { selectSeam } from './seam.js'
import type { Discovery } from './types.js'
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
  // [[UI297]] D7: the seam follows the provider; with none, no sign-in script is requested and the page says it is unavailable.
  const clerk = selectSeam(discovery)
  const api = createApi({ origin, getToken: async () => (clerk ? await clerk.getToken() : null), fetch: (input, init) => fetch(input, init) })
  const draw = (): void => render(root, buildView(page.state(), { origin, mcpUrl: discovery.mcp ?? null, profileUrl: clerk?.profileUrl() ?? null }), handlers)
  const page = createPage({ clerk, api, origin, onChange: draw })
  const handlers = {
    signIn: () => void page.signIn(),
    signOut: () => void page.signOut(),
    toggle: (id: string, disabled: boolean) => void page.setDisabled(id, disabled),
  }
  draw()
  await page.start()
}

void main()
