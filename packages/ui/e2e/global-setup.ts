// Builds the gallery with the exported esbuild options and serves `dist/gallery` statically on 127.0.0.1:4173 for the run.
import { createReadStream, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join } from 'node:path'
import { buildGallery, GALLERY_OUT } from '../scripts/build-gallery'

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
export const PORT = 4173

export default async function globalSetup(): Promise<() => Promise<void>> {
  await buildGallery(GALLERY_OUT)
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const file = join(GALLERY_OUT, path === '/' ? 'index.html' : path.replace(/\.\.+/g, ''))
    if (!existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
  return () => new Promise((resolve) => server.close(() => resolve()))
}
