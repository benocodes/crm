// Stub (red commit): the real Clerk env-file probe ([[OPS65]] D34).
import type { EnvFileProbe } from './types.js'

export function probeEnvFile(_arg: string | undefined, _envName: string, _repoRoot: string, _rootEnvPath: string): EnvFileProbe {
  throw new Error('not implemented')
}
