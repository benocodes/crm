// [[API7]] D24 ([[API220]]): the one budget of the per-minute invocation. It counts D1 queries (a `batch()` is one) and every outbound call together (fetches, R2 operations and Workflow creates),
// as Workers Free counts them (the repo's measured-limits rule: queries + external <= 50). The composition does the counting (a counting D1, fetch, R2 bucket and Workflow binding wrap what the tick's phases are given); a phase only ASKS `remaining()` before it starts a unit,
// so a tick never starts work it cannot finish. Exhaustion defers, never fails.

/** What a phase sees of the budget. */
export interface BudgetView {
  remaining(): number
}

export const DEFAULT_TICK_BUDGET = 50
const MIN_TICK_BUDGET = 50
const MAX_TICK_BUDGET = 1000

export class TickBudget implements BudgetView {
  used = 0
  constructor(readonly limit: number) {}
  spend(n = 1): void {
    this.used += n
  }
  remaining(): number {
    return Math.max(0, this.limit - this.used)
  }
  /** A view that may spend `maxSpend` more from now on, and never more than this budget has left. What the slice's phase spends is this budget's spending. */
  slice(maxSpend: number): BudgetView {
    const start = this.used
    return { remaining: () => Math.min(this.remaining(), Math.max(0, maxSpend - (this.used - start))) }
  }
}

/**
 * `CRON_TICK_BUDGET`: an integer 50..1000. Absent or blank is the default. Anything else is the default and a `problem` naming the variable (never its value): a bad value never fails a tick.
 */
export function parseTickBudget(raw: string | undefined): { limit: number; problem: string | null } {
  if (raw === undefined || raw.trim() === '') return { limit: DEFAULT_TICK_BUDGET, problem: null }
  const text = raw.trim()
  const n = /^\d{1,4}$/.test(text) ? Number(text) : NaN
  if (!Number.isInteger(n) || n < MIN_TICK_BUDGET || n > MAX_TICK_BUDGET) return { limit: DEFAULT_TICK_BUDGET, problem: 'CRON_TICK_BUDGET' }
  return { limit: n, problem: null }
}

/** `fetch` that spends one of the budget per call, whatever the answer (a refused or failed call still counted against the platform's limit). */
export function countFetch<F extends (...a: any[]) => Promise<Response>>(f: F, budget: TickBudget): F {
  return ((...a: Parameters<F>) => {
    budget.spend(1)
    return f(...a)
  }) as F
}
