// The dev server of the page bundles ([[UI489]] D5, D6): Vite on http://localhost:5173 with HMR and React Fast Refresh, in front of the local Worker (`wrangler dev`, :8787).
// It owns the page paths (the constants the Worker serves, P1), the page sources (`/assets/app/`, `/assets/ui/`, Vite's base is `/assets/`, UI504 D9) and Vite's own paths; every other request goes to the Worker unchanged (method, path, query, body, headers, Origin and Cookie
// included) and its answer comes back as sent, redirects unfollowed. Dev pages carry no CSP (Fast Refresh's preamble is an inline script); the built pages under `APP_CSP`/`PAGE_CSP` stay what the E2E scripts load.
import { readFileSync } from 'node:fs'
import { type IncomingMessage, request, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import { APP_PAGE_PATHS } from '../src/app/paths.js'
import { UI_PAGE_PATHS } from '../src/ui-serving.js'
import { APP_PAGE, devConfig, SRC, UI_PAGE } from './vite-pages.js'

export const DEV_PORT = 5173
export const WORKER_PORT = 8787

const PAGE_BY_PATH = new Map<string, typeof APP_PAGE>([
  ...APP_PAGE_PATHS.map((p) => [p, APP_PAGE] as const),
  ...UI_PAGE_PATHS.map((p) => [p, UI_PAGE] as const),
])
/** The page paths the dev server answers itself, derived from the two constants the Worker serves (never a third list). */
export const devOwnedPaths = (): string[] => [...PAGE_BY_PATH.keys()]

/** Path prefixes Vite answers: the page sources, and its own client, module and optimizer paths. */
const VITE_PREFIXES = ['/assets/', '/@vite/', '/@fs/', '/@id/', '/@react-refresh', '/node_modules/'] as const

export interface DevServer {
  url: string
  close(): Promise<void>
}

function proxy(upstream: URL, req: IncomingMessage, res: ServerResponse): void {
  const up = request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.headers)
      upRes.pipe(res)
    },
  )
  up.on('error', (e) => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`the Worker at ${upstream.origin} did not answer (${e.message}); is \`wrangler dev\` running?`)
  })
  req.pipe(up)
}

/** Starts the dev server; `upstream` is the Worker's origin. `port: 0` picks a free port (tests); anything else is strict. */
export async function startDevServer(opts: { upstream: string; port?: number }): Promise<DevServer> {
  const upstream = new URL(opts.upstream)
  // A plugin's `configureServer` runs before Vite's own middlewares, base middleware included (with the base `/assets/` Vite refuses a path outside it before our middleware could proxy it).
  const owner: Plugin = {
    name: 'vibase-dev-owner',
    configureServer(server) {
      // Added before Vite's own middlewares: the dev server decides what is Vite's and what is the Worker's.
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]!
        const page = req.method === 'GET' || req.method === 'HEAD' ? PAGE_BY_PATH.get(path) : undefined
        if (page) {
          const file = join(SRC, page.dir, 'index.html')
          server
            .transformIndexHtml(`/${page.dir}/index.html`, readFileSync(file, 'utf8'))
            .then((html) => {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
              res.end(html)
            })
            .catch(next)
          return
        }
        if (VITE_PREFIXES.some((p) => path.startsWith(p))) return next()
        proxy(upstream, req, res)
      })
    },
  }
  const vite: ViteDevServer = await createServer(devConfig({ port: opts.port ?? DEV_PORT, plugins: [owner] }))
  await vite.listen()
  const addr = vite.httpServer?.address()
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? DEV_PORT)
  return { url: `http://localhost:${port}`, close: () => vite.close() }
}
