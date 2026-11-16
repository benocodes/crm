// [[UI30]] D1-D13, [[UI256]]: the connect page's entry, and the one file here that imports `preact` itself (the rest import `react`, aliased by the build). Reads the instance's discovery document, builds the Clerk seam and the API client, and draws.
import { render } from 'preact'
import { createApi } from './api.js'
import { createPage } from './controller.js'
import { selectSeam } from './seam.js'
import type { Discovery } from './types.js'
import { buildView } from './view-model.js'
import { ConnectView, type Handlers } from './view.js'

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
    render(
      <ConnectView
        vm={{
          ...buildView({ kind: 'unavailable' }, { origin }),
          message: "This instance's configuration could not be read, so sign-in is unavailable.",
        }}
        handlers={{ signIn() {}, signOut() {}, toggle() {} }}
      />,
      root,
    )
    return
  }
  // [[UI297]] D7: the seam follows the provider; with none, no sign-in script is requested and the page says it is unavailable.
  const clerk = selectSeam(discovery)
  const api = createApi({
    origin,
    getToken: async () => (clerk ? await clerk.getToken() : null),
    fetch: (input, init) => fetch(input, init),
  })
  const draw = (): void =>
    render(
      <ConnectView
        vm={buildView(page.state(), { origin, mcpUrl: discovery.mcp ?? null, profileUrl: clerk?.profileUrl() ?? null })}
        handlers={handlers}
      />,
      root,
    )
  const page = createPage({ clerk, api, origin, onChange: draw })
  const handlers: Handlers = {
    signIn: () => void page.signIn(),
    signOut: () => void page.signOut(),
    toggle: (id: string, disabled: boolean) => void page.setDisabled(id, disabled),
  }
  draw()
  await page.start()
}

void main()
