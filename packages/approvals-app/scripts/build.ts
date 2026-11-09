// pnpm -C packages/approvals-app build -> dist/: app.js, app.css, index.html and `_headers` (the CSP and friends, applied by Workers Static Assets).
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { csp, resolveConfig } from '../src/config.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
export const OUT = fileURLToPath(new URL('../dist', import.meta.url))

export async function buildApp(env: Record<string, string | undefined> = process.env, out: string = OUT): Promise<void> {
  const config = resolveConfig(env)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  await build({
    entryPoints: [join(SRC, 'main.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    define: { __APP_CONFIG__: JSON.stringify(config) },
    outfile: join(out, 'app.js'),
    logLevel: 'warning',
  })
  copyFileSync(join(SRC, 'index.html'), join(out, 'index.html'))
  copyFileSync(join(SRC, 'app.css'), join(out, 'app.css'))
  writeFileSync(
    join(out, '_headers'),
    `/*\n  Content-Security-Policy: ${csp(config)}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Strict-Transport-Security: max-age=31536000\n/index.html\n  Cache-Control: no-store\n`,
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildApp()
  console.log(`approvals app built into ${OUT}`)
}
