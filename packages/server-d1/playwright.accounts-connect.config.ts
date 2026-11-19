// The connect-return E2E ([[UI469]]): Playwright against a local Worker on `better-auth` WITH the Gmail core variables set and no CONNECT_RETURN_URL. Its own config and script because Gmail on would flip `e2e:auth-pages`' 501 legs.
// Run by the coder and the tester, never by `pnpm test` or the gate; the recipe is in the spec's header.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'accounts-connect.e2e.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8787',
    ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
  },
})
