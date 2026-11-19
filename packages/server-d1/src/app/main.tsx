// The mount of the workspace app ([[UI460]] D4, D7, [[UI443]]): reads the instance's discovery, builds the session seam for this page, the API client and the state machine, and draws. The one file that imports `react-dom`.
// Mounted once inside a BrowserRouter ([[UI460]] D7 reversed: client-side routing, react-router declarative mode): discovery, the seam, the API and the controller live across navigation.
// Nothing is stored. Sign in goes back to the CURRENT page by its path only (read when signing in; a query is not carried); Clerk signs out to `<origin>/home`.
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { AppRoot } from './app.js'
import { createApi } from './session/api.js'
import { selectSeam } from './session/seam.js'
import type { Discovery } from './session/types.js'
import { createAppController } from './state.js'

async function discover(): Promise<Discovery | null> {
  try {
    const res = await fetch('/.well-known/vibase', { credentials: 'omit' })
    if (!res.ok) return null
    return (await res.json()) as Discovery
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const root = document.getElementById('root')
  if (!root) return
  const origin = location.origin
  // The router moves `location` with pushState, so a read at the moment of need is the current route.
  const path = () => location.pathname
  const discovery = await discover()
  const seam = selectSeam(discovery, { returnPath: path, signOutReturn: `${origin}/home` })
  const api = createApi({
    origin,
    getToken: async () => (seam ? await seam.getToken() : null),
    fetch: (input, init) => fetch(input, init),
  })
  const controller = createAppController({ seam, api, origin, path })
  // No transitions, as on the auth pages (UI446): a colour-scheme change must show at once, or a button is mid-colour for 150 ms and axe's contrast check (and a screenshot) catches it (UI460 E2E run).
  createRoot(root).render(
    <div className="[&_*]:transition-none!">
      <BrowserRouter>
        <AppRoot
          controller={controller}
          provider={discovery?.auth?.provider || null}
          origin={origin}
          mcpUrl={discovery?.mcp ?? null}
          api={api}
        />
      </BrowserRouter>
    </div>,
  )
  await controller.start()
}

void main()
