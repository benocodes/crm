import type { Deps, Operation } from './types.js'

export interface Discovered {
  ops: Operation[]
  /** The operations were fetched by this call, not read from the cache. */
  fresh: boolean
}
export function discover(_server: string, _deps: Deps, _opts: { cacheDir: string; refresh: boolean }): Promise<Discovered> {
  throw new Error('not implemented')
}
