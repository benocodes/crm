// The gallery's E2E ([[UI254]] D7): Playwright + Chromium against a static file server on localhost; no account, no network beyond localhost.
// Run by the tester, never by `pnpm test` or the gate:
//   pnpm -C packages/ui exec playwright install chromium
//   pnpm -C packages/ui e2e:gallery
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  // Chromium by default; `E2E_BROWSER_CHANNEL=chrome` uses an installed Google Chrome where the Chromium download is not possible.
  use: { baseURL: 'http://127.0.0.1:4173', ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}) },
})
