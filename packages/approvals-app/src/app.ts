import type { AppConfig } from './config.js'
import type { Env, ProviderModule } from './session.js'
import type { Provider } from './providers.js'
export interface Deps extends Env {
  config: AppConfig
  modules?: Record<Provider, () => Promise<ProviderModule>>
}
export async function run(_root: HTMLElement, _deps: Deps): Promise<void> {
  throw new Error('not implemented')
}
