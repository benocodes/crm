// [[UI247]] D5: the text of a scope. Vault scopes read the registry's one catalogue (`SCOPE_DESCRIPTIONS`), imported from its dependency-free leaf and so embedded into the bundle at build time (the
// bundle never imports `@vibase/api`'s index); the four OIDC scopes have this page's own sentences; anything else is shown by name with "No description". Every value is rendered as text.
import { SCOPE_DESCRIPTIONS } from '@vibase/api/scope-descriptions'
import type { ScopeItem } from '@vibase/ui'
import { MESSAGES } from './messages.js'

const OIDC: Readonly<Record<string, string>> = {
  openid: 'Know who you are: confirm your sign-in',
  profile: 'See your name and profile details',
  email: 'See your email address',
  offline_access: 'Stay signed in: keep access until you sign out or the access is revoked',
}

export function scopeItems(names: readonly string[]): ScopeItem[] {
  const seen = new Set<string>()
  const items: ScopeItem[] = []
  for (const name of names) {
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    items.push({ name, description: Object.hasOwn(OIDC, name) ? OIDC[name]! : Object.hasOwn(SCOPE_DESCRIPTIONS, name) ? SCOPE_DESCRIPTIONS[name]! : MESSAGES.noDescription })
  }
  return items
}
