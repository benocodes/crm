// `vibase-server owner-reset` ([[OPS307]] D9). STUB for the red commit.
import { type InstanceDeps } from './types.js'

export const EXIT_DONE = 0
export const EXIT_REFUSED = 2
export const EXIT_FAILED = 3

export async function runOwnerReset(_argv: string[], deps: InstanceDeps): Promise<number> {
  deps.err('vibase-server owner-reset: not implemented')
  return EXIT_REFUSED
}
