import { formatScope, type Scope } from '../scopes.js'
import type { Principal } from './types.js'

/**
 * [[CORE662]] ([[CORE630]] D8): the sentence appended to a `403 insufficient_scope` when a new sign-in would fix it, `null` otherwise. It applies when the operation's scope is held by the caller's live authority and missing from the token's
 * list (`Principal.signIn`, set by the built-in provider's authenticator): never for an API key, a session, a first-party app, or a scope the live authority lacks too. The words are fixed by the spec, one for each kind of caller.
 */
export function signInHint(principal: Pick<Principal, 'signIn'>, scope: Scope): string | null {
  const signIn = principal.signIn
  const name = formatScope(scope)
  if (!signIn || !signIn.missing.includes(name)) return null
  switch (signIn.kind) {
    case 'cli':
      return `this sign-in does not include ${name}, which your role holds: run \`vibase login\` to sign in again`
    case 'agent_account':
      return `this sign-in was made before ${name} was granted to this agent: sign in again as the agent with \`vibase login\``
    case 'delegated':
      return `this connection was approved before ${name} was granted: reconnect the connector to approve it`
  }
}
