// STUB for the red commit ([[CHN153]]). Replaced by the implementation in the green commit.
import type { Cmd, ConfigLike } from './remote.js'

const nope = (): never => {
  throw new Error('not implemented')
}
export const PULL_DIR = ''
export const PULL_VERBS: readonly string[] = []
export interface PullDeps {
  loadEnv(): void
  readConfig(envName: string): ConfigLike
  exec(cmd: Cmd): { status: number | null }
  readFile(path: string): string
  mkdir(path: string): void
  log(line: string): void
}
export const bucketOf = (_c: ConfigLike, _env: string): string => nope()
export const safeKey = (_k: string): boolean => nope()
export const parseIndex = (_t: string): string[] => nope()
export const getCommand = (_env: string, _bucket: string, _key: string, _file: string): Cmd => nope()
export const runPull = (_argv: string[], _env: NodeJS.ProcessEnv, _deps: PullDeps): number => nope()
