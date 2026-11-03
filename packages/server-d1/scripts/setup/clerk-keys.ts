// Stub (red commit): the Clerk key source, key kinds and signing-key derivation ([[OPS65]] D14, D34-D36). Implemented in the green commit.
import type { SetupDeps, SetupOptions } from './types.js'

export interface ClerkKeys {
  secretKey: string
  publishableKey: string
  kind: 'development' | 'production'
  issuer: string
  file: string
}
export function loadClerkKeys(_opts: SetupOptions, _deps: SetupDeps): ClerkKeys {
  throw new Error('not implemented')
}
export function decodePublishableKey(_pk: string): string {
  throw new Error('not implemented')
}
export function pemFromJwk(_jwk: unknown): string {
  throw new Error('not implemented')
}
