// pnpm -C packages/browser-app-example build:app -> dist/: app.js (the entry), app.css, index.html and `_headers`. Refuses, writing nothing, without VIBASE_URL and VIBASE_CLIENT_ID (DX637 P4).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { resolveConfig } from '../src/settings.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const SETTINGS_FILE = fileURLToPath(new URL('../settings.env', import.meta.url))
export const OUT = fileURLToPath(new URL('../dist', import.meta.url))

/** `settingsText` defaults to the gitignored `settings.env` when it exists (tests pass their own). */
export async function buildApp(
  env: Record<string, string | undefined> = process.env,
  out: string = OUT,
  settingsText: string = existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, 'utf8') : '',
): Promise<void> {
  const config = resolveConfig(env, settingsText)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  await build({
    entryPoints: { app: join(SRC, 'main.ts') },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    define: { __APP_CONFIG__: JSON.stringify(config) },
    outdir: out,
    logLevel: 'warning',
  })
  copyFileSync(join(SRC, 'index.html'), join(out, 'index.html'))
  copyFileSync(join(SRC, 'app.css'), join(out, 'app.css'))
  // The page may call its own origin and the deployment, and nothing else.
  writeFileSync(
    join(out, '_headers'),
    `/*\n  Content-Security-Policy: default-src 'self'; connect-src 'self' ${config.vibaseUrl}; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n/index.html\n  Cache-Control: no-store\n`,
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await buildApp()
    console.log(`browser app example built into ${OUT}`)
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}
