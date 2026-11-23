// [[UI455]] P2 ([[UI449]] D3 to D6): the consent page's pure model. `buildConsentModel` groups the requested scope names into the fixed sign-in line and the areas (catalogue order, then "Other"),
// with one switch per requested action; `defaultState` is D4's defaults; `grantedScopes` is the `scope` Allow sends. Imports the catalogue leaf only, never `@vibase/api`'s index.
import { NOT_DEFAULT_GRANT, SCOPE_AREAS, areaOfScope } from '@vibase/api/scope-areas'
import { MESSAGES } from './messages.js'

export type SwitchKind = 'read' | 'read_sensitive' | 'request_approval' | 'write' | 'name'
export type SwitchDef = {
  /** Unique on the page: `<area>:<kind>`, or `other:name:<scope>` for an unparseable name. */
  id: string
  areaKey: string
  kind: SwitchKind
  label: string
  /** The requested scopes this switch grants. */
  scopes: string[]
  defaultOn: boolean
}
export type AreaModel = { key: string; name: string; sentence: string; requested: string[]; switches: SwitchDef[] }
export type ConsentModel = { requested: string[]; signIn: string[]; areas: AreaModel[] }
/** The owner's own position of each switch. A Propose switch's value is kept while Write forces it on, so Write off restores it. */
export type SwitchState = Record<string, boolean>

export const SIGN_IN_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'offline_access']
const PARSEABLE = /^([a-z][a-z0-9_]*):(read|read_metadata|request_approval|write)$/
const ACTIONS = ['read', 'request_approval', 'write'] as const
const OTHER = 'other'

const LABELS = {
  read: MESSAGES.switchRead,
  read_sensitive: MESSAGES.switchReadSensitive,
  request_approval: MESSAGES.switchPropose,
  write: MESSAGES.switchWrite,
} as const

export function buildConsentModel(names: readonly string[]): ConsentModel {
  const requested = [...new Set(names.filter((n) => n !== ''))]
  const signIn = requested.filter((n) => SIGN_IN_SCOPES.includes(n))
  const groups = new Map<string, string[]>()
  for (const name of requested) {
    if (SIGN_IN_SCOPES.includes(name)) continue
    const key = areaOfScope(name) ?? OTHER
    groups.set(key, [...(groups.get(key) ?? []), name])
  }
  const areas: AreaModel[] = []
  const meta = [
    ...SCOPE_AREAS.map((a) => ({ key: a.key, name: a.name, sentence: a.sentence })),
    { key: OTHER, name: MESSAGES.areaOther, sentence: MESSAGES.areaOtherSentence },
  ]
  for (const { key, name, sentence } of meta) {
    const scopes = groups.get(key)
    if (!scopes) continue
    const switches: SwitchDef[] = []
    for (const action of ACTIONS) {
      // [[API518]] D2: a requested `read_metadata` rides on its area's Read switch (a read action); it has no switch of its own.
      const ofAction = scopes.filter((s) => {
        const a = PARSEABLE.exec(s)?.[2]
        return a === action || (action === 'read' && a === 'read_metadata')
      })
      if (ofAction.length === 0) continue
      if (action === 'read') {
        // D4 in the coder's shape (decision 455.8): a scope in NOT_DEFAULT_GRANT never rides on the area's Read switch when that switch is on by default; it gets its own switch, off.
        const sensitive = ofAction.filter((s) => NOT_DEFAULT_GRANT.includes(s))
        const plain = ofAction.filter((s) => !NOT_DEFAULT_GRANT.includes(s))
        if (plain.length > 0)
          switches.push({
            id: `${key}:read`,
            areaKey: key,
            kind: 'read',
            label: LABELS.read,
            scopes: plain,
            defaultOn: true,
          })
        if (sensitive.length > 0) {
          const alone = plain.length === 0
          switches.push({
            id: alone ? `${key}:read` : `${key}:read_sensitive`,
            areaKey: key,
            kind: alone ? 'read' : 'read_sensitive',
            label: alone ? LABELS.read : LABELS.read_sensitive,
            scopes: sensitive,
            defaultOn: false,
          })
        }
        continue
      }
      switches.push({
        id: `${key}:${action}`,
        areaKey: key,
        kind: action,
        label: LABELS[action],
        scopes: ofAction,
        defaultOn: action === 'request_approval',
      })
    }
    for (const s of scopes)
      if (!PARSEABLE.test(s))
        switches.push({ id: `${key}:name:${s}`, areaKey: key, kind: 'name', label: s, scopes: [s], defaultOn: false })
    areas.push({ key, name, sentence, requested: scopes, switches })
  }
  return { requested, signIn, areas }
}

export function defaultState(m: ConsentModel): SwitchState {
  return Object.fromEntries(m.areas.flatMap((a) => a.switches.map((w) => [w.id, w.defaultOn])))
}

/** What the switch grants now: Propose is on while its area's Write is on (D3), whatever its own position. */
export function effectiveOn(m: ConsentModel, state: SwitchState, sw: SwitchDef): boolean {
  if (sw.kind === 'request_approval') {
    const write = m.areas.find((a) => a.key === sw.areaKey)?.switches.find((w) => w.kind === 'write')
    if (write && state[write.id]) return true
  }
  return !!state[sw.id]
}

/** D6: the sign-in line plus the scopes of every switched-on switch, request order, single-space separated, no repeats. Empty means nothing would be granted. */
export function grantedScopes(m: ConsentModel, state: SwitchState): string {
  const granted = new Set(m.signIn)
  for (const a of m.areas)
    for (const w of a.switches) if (effectiveOn(m, state, w)) for (const s of w.scopes) granted.add(s)
  return m.requested.filter((s) => granted.has(s)).join(' ')
}
