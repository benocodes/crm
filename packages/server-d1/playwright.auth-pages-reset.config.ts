// The self-service reset E2E ([[CORE304]]): Playwright against a local Worker on `better-auth` WITH email on (a recording `EMAIL` binding, `src/test/entry-email.ts`), over HTTPS like `playwright.oauth-pages.config.ts`.
// A separate config and script from `e2e:auth-pages` because it needs its own Worker (email on) and its own fresh local state. Run by the tester, never by `pnpm test` or the gate; the recipe is in the spec's header.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'auth-pages-reset.e2e.ts',
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
