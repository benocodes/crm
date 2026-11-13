import type { D1Like, D1PreparedLike } from '@vibase/storage-d1'
import type { TickBudget } from '@vibase/api'

// [[API7]] D24 ([[API220]]): the tick's counters. D24's "outbound" is every external call the invocation makes (the planner's clarification): fetches, R2 operations and Workflow creates, beside D1
// queries. `countD1` is a D1 that spends one of the tick's budget per query: `run`, `all` and `first` are one each, and a `batch()` is one however many statements it holds (the platform's own
// count, and the repo's measured-limits rule). It changes nothing else: the statements, their order and their results are the real D1's.
export function countD1(real: D1Like, budget: TickBudget): D1Like {
  // `batch` must hand the REAL prepared statements to the real D1, so each wrapper remembers its own.
  const inners = new WeakMap<object, D1PreparedLike>()
  const wrap = (inner: D1PreparedLike): D1PreparedLike => {
    const w: D1PreparedLike = {
      bind: (...values: unknown[]) => wrap(inner.bind(...values)),
      run: () => (budget.spend(1), inner.run()),
      all: () => (budget.spend(1), inner.all()),
      first: () => (budget.spend(1), inner.first()),
    }
    inners.set(w, inner)
    return w
  }
  return {
    prepare: (query: string) => wrap(real.prepare(query)),
    batch(statements: D1PreparedLike[]) {
      budget.spend(1)
      return real.batch(statements.map((s) => inners.get(s) ?? s))
    },
  }
}

/**
 * A binding (an R2 bucket, the Workflow binding) whose listed methods each spend one of the tick's budget per call, whatever the answer; every other property passes through untouched. Handed to
 * the rail's Gmail transport for the tick only, so request-path traffic is never counted.
 */
export function countCalls<T extends object>(real: T, methods: readonly (keyof T & string)[], budget: TickBudget): T {
  return new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      const counted = (methods as readonly string[]).includes(String(prop))
      return (...args: unknown[]) => {
        if (counted) budget.spend(1)
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
      void receiver
    },
  })
}
