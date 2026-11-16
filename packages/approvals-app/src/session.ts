// The seam between the page and a sign-in provider: one `Session` per provider module (clerk.ts, better-auth.ts), chosen at load from discovery (app.ts).
import type { AppConfig } from './config.js'

export interface Session {
  signedIn: boolean
  email: string | null
  /** A fresh API bearer token per call; null when signed out or when the provider cannot give one. */
  token(): Promise<string | null>
  signIn(): Promise<void>
  signOut(): Promise<void>
}

/** What a provider module may touch of the browser, injected so tests run it without one. */
export interface Env {
  fetch: typeof fetch
  location: { href: string; assign(url: string): void; reload(): void }
}

export interface ProviderModule {
  loadSession(config: AppConfig, env: Env): Promise<Session>
}
