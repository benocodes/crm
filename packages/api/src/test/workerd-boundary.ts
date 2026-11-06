// Test-only: a Workflow step shim that emulates workerd's boundary, not just the control flow ([[CHN5]] D11, invariant 7, `cloudflare-workflows`).
//  - a step's return value is walked with workerd's accept-list and rejected by constructor name and property path (a class instance, a function,
//    a symbol; Node's `structuredClone` would downgrade an instance silently), then cloned, so a later step never sees a shared reference;
//  - a thrown error arrives as a bare `Error` with its message (class, prototype and custom fields gone);
//  - `sleep` records its duration and returns at once; `retries` re-runs a failing step the way the runtime would.
import type { StepConfig, WorkflowStepLike } from '../sync/workflow-run.js'

export interface StepShim {
  step: WorkflowStepLike
  /** Every step name executed, in order (a retry repeats its name). */
  names: string[]
  sleeps: Array<{ name: string; duration: string | number }>
  /** What each step returned (after the clone), in order. */
  returns: Array<{ name: string; value: unknown }>
}
export interface ShimOptions {
  /** Retries of a failing step (workerd's default is 5; the shim's is 0 so a test sees the first failure). */
  retries?: number
  /** Runs after a step's body returned and before its result is stored: throw to model a failure after the unit committed. */
  afterCommit?: (name: string, attempt: number) => void | Promise<void>
  /** Runs before a step body: throw to model an instance killed at that step (nothing after it runs). */
  beforeStep?: (name: string) => void | Promise<void>
}

export class NotSerialisable extends Error {
  constructor(path: string, what: string) {
    super(`Value returned from step is not serialisable at ${path}: ${what}`)
  }
}

/** workerd's accept-list: primitives, Date, Map, Set, typed arrays, plain objects and arrays of those. Anything else is named by constructor. */
export function assertCloneable(value: unknown, path: string, seen: Set<object> = new Set()): void {
  if (value === null || value === undefined) return
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return
  if (t === 'function' || t === 'symbol') throw new NotSerialisable(path, `a ${t}`)
  const o = value as object
  if (seen.has(o)) throw new NotSerialisable(path, 'a cycle')
  if (o instanceof Date || o instanceof Uint8Array || o instanceof ArrayBuffer) return
  if (o instanceof Map) {
    seen.add(o)
    for (const [k, v] of o) {
      assertCloneable(k, `${path}.<key>`, seen)
      assertCloneable(v, `${path}.<value>`, seen)
    }
    seen.delete(o)
    return
  }
  if (o instanceof Set) {
    seen.add(o)
    for (const v of o) assertCloneable(v, `${path}.<member>`, seen)
    seen.delete(o)
    return
  }
  if (Array.isArray(o)) {
    seen.add(o)
    o.forEach((v, i) => assertCloneable(v, `${path}[${i}]`, seen))
    seen.delete(o)
    return
  }
  const proto = Object.getPrototypeOf(o)
  if (proto !== Object.prototype && proto !== null) throw new NotSerialisable(path, `Could not serialize object of type "${(o as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'}"`)
  seen.add(o)
  for (const [k, v] of Object.entries(o)) assertCloneable(v, `${path}.${k}`, seen)
  seen.delete(o)
}

export function makeWorkerdStepShim(opts: ShimOptions = {}): StepShim {
  const names: string[] = []
  const sleeps: StepShim['sleeps'] = []
  const returns: StepShim['returns'] = []
  const run = async <T>(name: string, config: StepConfig | undefined, fn: () => Promise<T>): Promise<T> => {
    const limit = opts.retries ?? config?.retries?.limit ?? 0
    for (let attempt = 0; ; attempt++) {
      names.push(name)
      try {
        await opts.beforeStep?.(name)
        const value = await fn()
        await opts.afterCommit?.(name, attempt)
        assertCloneable(value, `step(${JSON.stringify(name)})`)
        const stored = value === undefined ? value : structuredClone(value)
        returns.push({ name, value: stored })
        return stored
      } catch (err) {
        if (err instanceof NotSerialisable && opts.retries === undefined) throw err
        if (attempt >= limit) throw new Error(err instanceof Error ? err.message : String(err))
      }
    }
  }
  const step: WorkflowStepLike = {
    do: ((name: string, a: StepConfig | (() => Promise<unknown>), b?: () => Promise<unknown>) => (typeof a === 'function' ? run(name, undefined, a) : run(name, a, b!))) as WorkflowStepLike['do'],
    sleep: async (name, duration) => {
      names.push(name)
      sleeps.push({ name, duration })
    },
  }
  return { step, names, sleeps, returns }
}
export type { StepConfig }
