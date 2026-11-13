import type { InstanceDeps } from './types.js'

/** Exit codes: 0 current; 1 behind (a plan was printed); 2 refused. */
export async function runStatus(_argv: string[], _deps: InstanceDeps): Promise<number> {
  throw new Error('not implemented')
}
