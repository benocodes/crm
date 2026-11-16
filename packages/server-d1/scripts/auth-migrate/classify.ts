import type { AuthPlan, Snapshot } from './types.js'

export type PlanBody = Pick<AuthPlan, 'people' | 'clerk_only' | 'agents'>

export function classify(_snapshot: Snapshot, _newId: () => string): PlanBody {
  return { people: [], clerk_only: [], agents: [] }
}
