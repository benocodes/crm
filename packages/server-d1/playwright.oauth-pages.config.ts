// The OAuth pages' E2E ([[UI247]]): Playwright against a local Worker (`wrangler dev --local --local-protocol https`) on `better-auth`, like `playwright.auth-pages.config.ts` (same prerequisites, no Clerk, no `.env.dev`, no network
// beyond localhost). Run by the tester, never by `pnpm test` or the gate:
//   E2E_INVITE_URL=<the URL bootstrap printed> pnpm -C packages/server-d1 e2e:oauth-pages
// HTTPS because the real `vibase login` refuses an http issuer. It signs the invited person up itself (its own fresh database), so it does not share a database with `e2e:auth-pages`: start from a fresh local state for each.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'oauth-pages.e2e.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://localhost:8787',
    ignoreHTTPSErrors: true,
    ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
  },
})
