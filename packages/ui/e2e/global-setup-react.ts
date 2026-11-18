// Builds the React gallery with the D8 helper and serves it on 127.0.0.1:4174 with `PAGE_CSP` as its response header ([[UI445]] D9).
// `E2E_GALLERY_MUTATION=style-attr|style-element` injects an inline style into the served page, to prove the CSP check bites.
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join } from 'node:path'
import { buildGalleryReact } from '../scripts/build-gallery-react'
import { PAGE_CSP } from '../src/csp'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}
export const PORT = 4174

export default async function globalSetup(): Promise<() => Promise<void>> {
  const out = process.env.E2E_GALLERY_OUT ?? join(import.meta.dirname, '..', 'dist', 'gallery-react-e2e')
  await buildGalleryReact(out)
  const mutation = process.env.E2E_GALLERY_MUTATION
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const file = join(out, path === '/' ? 'index.html' : path.replace(/\.\.+/g, ''))
    if (!existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    const headers = {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': PAGE_CSP,
    }
    res.writeHead(200, headers)
    if (extname(file) === '.html' && mutation) {
      const inject = mutation === 'style-element' ? '<style>body{outline:1px solid red}</style>' : ''
      const html = readFileSync(file, 'utf-8').replace(
        '<body>',
        `<body ${mutation === 'style-attr' ? 'style="color:red"' : ''}>${inject}`,
      )
      res.end(html)
      return
    }
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
  return () => new Promise((resolve) => server.close(() => resolve()))
}
