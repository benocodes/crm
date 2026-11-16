// The auth migration E2E ([[OPS397]]): Playwright with a Node-side driver around the real `plan`, `apply` and `claim` code, a local Worker that changes provider mid-run (Clerk, then Better Auth) and the Clerk DEVELOPMENT instance whose keys are in the gitignored `.env.dev`.
// A separate config and script: no existing script can host it, since its Worker changes provider (CORE304 lesson). Run by the tester, never by `pnpm test` or the gate; the recipe is in the spec's header.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'
import { loadDevClerkEnv } from './scripts/e2e-env.ts'

const here = dirname(fileURLToPath(import.meta.url))
const devEnv = process.env.E2E_DEV_ENV_FILE ?? join(here, '../../.env.dev')
const keys = loadDevClerkEnv(devEnv)
process.env.CLERK_SECRET_KEY = keys.secretKey
process.env.CLERK_PUBLISHABLE_KEY = keys.publishableKey
process.env.E2E_CLERK_ISSUER = keys.issuer
// the Worker's session-token verification key (a public PEM), from the same development file
process.env.CLERK_JWT_KEY = parseEnv(readFileSync(devEnv, 'utf8')).CLERK_JWT_KEY ?? ''

export default defineConfig({
  testDir: './e2e',
  testMatch: 'auth-migration.e2e.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // the Worker is started five times (about 15 s each)
  timeout: 300_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${process.env.E2E_PORT ?? '8787'}`,
    ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
  },
})
