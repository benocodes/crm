import type { Deps } from './types.js'

/** Runs one command line and returns the exit code. Never throws, never exits the process. */
export async function run(_argv: string[], _deps: Deps): Promise<number> {
  throw new Error('not implemented')
}
