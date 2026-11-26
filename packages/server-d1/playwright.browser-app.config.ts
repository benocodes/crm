// The browser sign-in example's E2E ([[DX637]] P7): Playwright against a local Worker on `better-auth` (:8787, started by the operator like `e2e:approvals-app`).
// Unlike the approvals config there is no `webServer`: the example is built with the `client_id` that exists only after the owner signs up and registers the client,
// so e2e/browser-app.e2e.ts builds and serves it (:5180, inspector port 9231) itself once the client exists. No Clerk, no `.env.dev`, no network beyond localhost.
// Run by the tester, never by `pnpm test` or the gate:
//   pnpm -C packages/server-d1 exec playwright install chromium     (or E2E_BROWSER_CHANNEL=chrome)
//   E2E_INVITE_URL=<the URL bootstrap printed> pnpm -C packages/server-d1 e2e:browser-app
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'browser-app.e2e.ts',
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
