// [[CORE199]] D10, D12 built by [[CORE201]]: the two checked-in lists of the registry filter contract. Plain data in package source, so the contract test
// checks them and discovery derives `indexed` from them at runtime (a column filter is indexed unless it is listed here).

/** A list x column filter whose `eq` D1 plan is not searched through an index constraining that column, accepted with a reason. Exact: the contract fails on a missing, obsolete or unknown entry. */
export interface StatedFilterCost { readonly list: string; readonly filter: string; readonly reason: string }
/** A hand-written registry list outside the filter rollout, with the reason. */
export interface FilterExemption { readonly list: string; readonly reason: string }

export const STATED_FILTER_COSTS: readonly StatedFilterCost[] = []

export const FILTER_EXEMPT_LISTS: readonly FilterExemption[] = []
