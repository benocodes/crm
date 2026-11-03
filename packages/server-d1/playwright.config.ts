// The connect page's E2E ([[UI30]]): Playwright with @clerk/testing against a local Worker (`wrangler dev --local`) and the Clerk DEVELOPMENT
// instance whose keys are in the gitignored `.env.dev`. Run by the tester, never by `pnpm test` or the gate:
//   pnpm -C packages/server-d1 exec playwright install chromium
//   pnpm -C packages/server-d1 e2e:connect
// The keys are read from `.env.dev` only (`E2E_DEV_ENV_FILE` may name another file called `.env.dev`), development keys only, and handed to the
// specs through this process's environment. Nothing here reads the root `.env` or an `.env.hq*` file.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'
import { loadDevClerkEnv } from './scripts/e2e-env.ts'

const here = dirname(fileURLToPath(import.meta.url))
const keys = loadDevClerkEnv(process.env.E2E_DEV_ENV_FILE ?? join(here, '../../.env.dev'))
process.env.CLERK_SECRET_KEY = keys.secretKey
process.env.CLERK_PUBLISHABLE_KEY = keys.publishableKey
process.env.E2E_CLERK_ISSUER = keys.issuer

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  // One worker: the specs share one local D1 and three Clerk test users.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8787', trace: 'retain-on-failure' },
})
