// The auth pages' E2E ([[UI246]]): Playwright against a local Worker (`pnpm dev`, wrangler --local) on `better-auth`. Its own config: no Clerk, no `.env.dev`, no account, no network beyond localhost.
// Run by the tester, never by `pnpm test` or the gate:
//   pnpm -C packages/server-d1 exec playwright install chromium     (or E2E_BROWSER_CHANNEL=chrome)
//   E2E_INVITE_URL=<the URL bootstrap printed> pnpm -C packages/server-d1 e2e:auth-pages
// The page must be opened at `http://localhost:8787` exactly (not 127.0.0.1): Better Auth's origin check trusts PUBLIC_BASE_URL only.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'auth-pages.e2e.ts',
  // Serial in one file: the steps share one fresh database.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // The steps include rate-limit waits and Chrome start-up: a generous per-test limit.
  timeout: 180_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8787',
    ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
  },
})
