// The page (DX637 D11). Stub: red commit.
import type { AppConfig } from './settings.js'

export interface RunOptions {
  config: AppConfig
  fetch: typeof fetch
  location: { href: string; origin: string }
  navigate?: (url: string) => void
  replaceUrl?: (url: string) => void
  sessionStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
}
export async function run(_root: HTMLElement, _options: RunOptions): Promise<void> {}
