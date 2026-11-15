// `bootstrap --remote --env <name> --owner-reset` ([[OPS307]] D9), the source twin of `vibase-server owner-reset`. STUB for the red commit.
import type { D1Like } from '@vibase/storage-d1'
import type { ConfigLike } from './remote.js'

export interface OwnerResetRemoteDeps {
  loadEnv(): void
  readConfig(envName: string): ConfigLike & { vars?: Record<string, unknown> }
  readInstanceEnv(envName: string): { display: string; status: 'ok' | 'missing' | 'not-ignored' | 'root-env'; text?: string }
  getPlatformProxy(envName: string): Promise<{ env: { DB: D1Like; CONTROL_DB?: D1Like }; dispose(): Promise<void> }>
  log(line: string): void
  error(line: string): void
}

export async function runOwnerResetRemote(_argv: string[], _env: NodeJS.ProcessEnv, deps: OwnerResetRemoteDeps): Promise<number> {
  deps.error('bootstrap: --owner-reset is not implemented')
  return 1
}
