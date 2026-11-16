// The approvals app's E2E ([[UI388]]): Playwright against a local Worker on `better-auth` (:8787, started by the operator like `e2e:auth-pages`) and the approvals app itself,
// built for that Worker and served by its own `wrangler dev` on :8788 (a real listener with the real `_headers`, started here). No Clerk, no `.env.dev`, no account, no network beyond localhost.
// Run by the tester, never by `pnpm test` or the gate:
//   pnpm -C packages/server-d1 exec playwright install chromium     (or E2E_BROWSER_CHANNEL=chrome)
//   E2E_INVITE_URL=<the URL bootstrap printed> pnpm -C packages/server-d1 e2e:approvals-app
// Worker prerequisites: see e2e/approvals-app.e2e.ts. Two `wrangler dev` processes run at once: the app's gets `--inspector-port=9230` so it does not contend for the Worker's inspector port.
// reuseExistingServer: anything already listening on :8788 is used as is, and the `env` below is then not applied (a stray app built for another API origin
// is tested instead). Stop stray listeners first (`lsof -i :8788`).
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'approvals-app.e2e.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  webServer: {
    command: 'pnpm -C ../approvals-app dev --inspector-port=9230',
    url: 'http://localhost:8788/',
    reuseExistingServer: true,
    timeout: 120_000,
    env: { APPROVALS_API_ORIGIN: 'http://localhost:8787', WRANGLER_SEND_METRICS: 'false', CI: '1' },
  },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8787',
    ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
  },
})
