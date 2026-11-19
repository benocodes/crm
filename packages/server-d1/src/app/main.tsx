// The mount of the workspace app ([[UI460]] D4, D7, [[UI443]]): reads the instance's discovery, builds the session seam for this page, the API client and the state machine, and draws. The one file that imports `react-dom`.
// Nothing is stored. Sign in goes back to this page by its path only (a query on the page is not carried); Clerk signs out to `<origin>/home`.
import { createRoot } from 'react-dom/client'
import { AppRoot } from './app.js'
import { createApi } from './session/api.js'
import { selectSeam } from './session/seam.js'
import type { Discovery } from './session/types.js'
import { createAppController } from './state.js'

const TITLES: Record<string, string> = { '/home': 'Home', '/accounts': 'Connected accounts', '/agents': 'Agents' }
document.title = `${TITLES[location.pathname] ?? 'Home'} · Vibase`

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
  const path = location.pathname
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
      <AppRoot
        controller={controller}
        provider={discovery?.auth?.provider || null}
        path={path}
        origin={origin}
        mcpUrl={discovery?.mcp ?? null}
        api={api}
      />
    </div>,
  )
  await controller.start()
}

void main()
