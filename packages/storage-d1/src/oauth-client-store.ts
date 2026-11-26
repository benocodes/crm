// STUB (red commit): the first-party OAuth client store ([[CORE623]] cycle 1). Replaced by the implementation in the green commit.
import type { ControlDb } from './control-store.js'

export interface OAuthClientRecord {
  clientId: string
  name: string
  redirectUris: string[]
  scopes: string[]
  skipConsent: boolean
  createdAt: string
  updatedAt: string
}
export interface NewOAuthClient {
  organizationId: string
  clientId: string
  name: string
  redirectUris: string[]
  scopes: string[]
  skipConsent: boolean
  resources: readonly string[]
  actorId: string
  now: string
  newId: () => string
}
export interface OAuthClientChange {
  organizationId: string
  clientId: string
  actorId: string
  now: string
  newId: () => string
  name?: string
  redirectUris?: string[]
  scopes?: string[]
  skipConsent?: boolean
}
const nope = (): never => {
  throw new Error('not implemented')
}
export const createOAuthClient = async (_c: ControlDb, _a: NewOAuthClient): Promise<OAuthClientRecord | 'exists'> =>
  nope()
export const listOAuthClients = async (_c: ControlDb, _a: { organizationId: string }): Promise<OAuthClientRecord[]> =>
  nope()
export const getOAuthClient = async (
  _c: ControlDb,
  _a: { organizationId: string; clientId: string },
): Promise<OAuthClientRecord | null> => nope()
export const updateOAuthClient = async (_c: ControlDb, _a: OAuthClientChange): Promise<OAuthClientRecord | null> =>
  nope()
export const deleteOAuthClient = async (
  _c: ControlDb,
  _a: { organizationId: string; clientId: string; actorId: string; now: string; newId: () => string },
): Promise<boolean> => nope()
