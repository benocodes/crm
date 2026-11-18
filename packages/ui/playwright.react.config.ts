// The React gallery's E2E ([[UI445]] D9): Chromium against a static server on localhost with PAGE_CSP; no account, no network beyond localhost.
// Run by the tester, never by `pnpm test` or the gate:  pnpm -C packages/ui e2e:gallery-react
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'gallery-react.e2e.ts',
  globalSetup: './e2e/global-setup-react.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
  },
})
