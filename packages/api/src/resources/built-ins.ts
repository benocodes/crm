// The four extensible built-ins as one set ([[CORE315]] D1, D23; [[CORE559]] P1, P2). `createBuiltIns(extend)` is the ONE constructor of their definitions at start: each is built from its declaration plus its `extend` entry, with no
// module-level mutable state, and every path that names a record of contacts, companies, deals or tasks (the cascades, `identities.resolve`, merge, `deals.move_stage`, the form submission, the registry) takes the set it was given.
// The module constants (`contacts`, ...) are the set with no `extend`: what a deployment without one serves.
import type { ExtendDeclarations } from '../custom/extend.js'
import type { AnyResource } from '../registry.js'
import { companies, defineCompanies } from './companies.js'
import { contacts, defineContacts } from './contacts.js'
import { deals, defineDeals } from './deals.js'
import { defineTasks, tasks } from './tasks.js'

/** What the delete cascades need of the set: the definitions, as the generic layer sees them. */
export interface BuiltInLookup {
  readonly contacts: AnyResource
  readonly companies: AnyResource
  readonly deals: AnyResource
  readonly tasks: AnyResource
}
/** The set with the record types of each definition (a custom field is a run-time key: typed `unknown` at compile time, row 559.13). */
export interface BuiltIns extends BuiltInLookup {
  readonly contacts: typeof contacts
  readonly companies: typeof companies
  readonly deals: typeof deals
  readonly tasks: typeof tasks
}

/** The set built from `extend` (the [[CORE555]] validator's output). Absent or empty: the module constants' definitions. */
export function createBuiltIns(extend: ExtendDeclarations = {}): BuiltIns {
  // The definitions' delete overrides reach the set through this lookup, filled just below.
  const set = {} as { -readonly [K in keyof BuiltIns]: BuiltIns[K] }
  const lookup = () => set
  set.contacts = defineContacts(extend.contacts, lookup)
  set.companies = defineCompanies(extend.companies, lookup)
  set.deals = defineDeals(extend.deals, lookup)
  set.tasks = defineTasks(extend.tasks, lookup)
  return set
}

let defaults: BuiltIns | undefined
/** The set with no `extend`: the module constants (hoisted, so the resource modules may name it from their own initialisation). */
export function defaultBuiltIns(): BuiltIns {
  return (defaults ??= { contacts, companies, deals, tasks })
}
