// The provider modules, each behind a dynamic import so a Clerk instance never downloads the Better Auth client (and the reverse): the build splits them into chunks.
import type { ProviderModule } from './session.js'

export type Provider = 'clerk' | 'better-auth'
export const providerModules: Record<Provider, () => Promise<ProviderModule>> = {
  clerk: () => import('./clerk.js'),
  'better-auth': () => import('./better-auth.js'),
}
