// Stub (red commit): the flags of `vibase instance setup` ([[OPS232]] P1).
import type { SetupOptions } from '../setup/types.js'

export function parseInstanceSetupArgs(_argv: string[]): { opts: SetupOptions; settingsPath?: string; secretsPath?: string } {
  throw new Error('not implemented')
}
