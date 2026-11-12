import type { D1Like, D1PreparedLike } from '@vault/storage-d1'
import type { TickBudget } from '@vault/api'

// [[API7]] D24 ([[API220]]): a D1 that spends one of the tick's budget per query: `run`, `all` and `first` are one each, and a `batch()` is one however many statements it holds (the platform's own
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
