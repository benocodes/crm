// STUB for the red commit ([[OPS494]]); replaced by the implementation.
import type { InstanceDeps } from './types.js'

export async function runInit(_argv: string[], _deps: InstanceDeps): Promise<number> {
  return 99
}

export function createSecretsFile(_path: string, _text: string, _ops?: unknown): void {
  throw new Error('not implemented')
}
