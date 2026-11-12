// [[API7]] D24 ([[API220]]): STUB for the red commit.
export interface BudgetView {
  remaining(): number
}
export const DEFAULT_TICK_BUDGET = 50
export class TickBudget implements BudgetView {
  used = 0
  constructor(readonly limit: number) {}
  spend(_n = 1): void {}
  remaining(): number {
    return 0
  }
  slice(_maxSpend: number): BudgetView {
    return this
  }
}
export function parseTickBudget(_raw: string | undefined): { limit: number; problem: string | null } {
  return { limit: 0, problem: null }
}
export function countFetch<F extends (...a: any[]) => Promise<Response>>(f: F, _budget: TickBudget): F {
  return f
}
