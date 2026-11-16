import type { Cmd, ConfigLike } from './remote.js'
import type { EnvFileProbe } from './setup/types.js'

export interface PlanDeps {
  loadEnv(envName: string): void
  readConfig(envName: string): ConfigLike & { vars?: Record<string, unknown> }
  readInstanceEnv(envName: string): EnvFileProbe
  exec(cmd: Cmd): { status: number | null; stdout: string }
  fetch: typeof fetch
  /** Does the path exist? */
  exists(path: string): boolean
  /** Is the path inside the repository checkout and not ignored by git? */
  repoPathNotIgnored(path: string): boolean
  /** Creates the file exclusively (`wx`) with the mode, and its directory when missing. */
  writeNew(path: string, text: string, mode: number): void
  now(): Date
  newId(): string
  log(line: string): void
  error(line: string): void
}

export async function runAuthMigrate(_argv: string[], _env: NodeJS.ProcessEnv, _deps: PlanDeps): Promise<number> {
  return 0
}

export const defaultPlanPath = (_env: string, _procEnv: NodeJS.ProcessEnv, _home: string): string => ''
export const realFileDeps: Pick<PlanDeps, 'exists' | 'repoPathNotIgnored' | 'writeNew'> = {
  exists: () => false,
  repoPathNotIgnored: () => false,
  writeNew: () => {},
}
