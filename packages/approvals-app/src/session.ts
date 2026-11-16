// stub (red commit)
import type { AppConfig } from './config.js'
export interface Session {
  signedIn: boolean
  email: string | null
  token(): Promise<string | null>
  signIn(): Promise<void>
  signOut(): Promise<void>
}
export interface Env {
  fetch: typeof fetch
  location: { href: string; assign(url: string): void; reload(): void }
}
export interface ProviderModule {
  loadSession(config: AppConfig, env: Env): Promise<Session>
}
