// Shared types of `setup:remote` ([[OPS65]] D6, D7): the step model and the seams the tests fake (command runner, fetch, files, D1).
import type { D1Like } from '@vault/storage-d1'

export const STEP_NAMES = ['preflight', 'config:resources', 'config:write', 'migrate', 'bootstrap', 'deploy', 'verify'] as const
export type StepName = (typeof STEP_NAMES)[number]

/** `blocked` is this cycle's addition to the spec's five: a step that cannot be evaluated until an earlier planned change lands (a dry run's later steps). It never fails the run. */
export type Status = 'ok' | 'create' | 'update' | 'manual' | 'fail' | 'blocked'

export interface StepResult {
  step: StepName
  status: Status
  detail: string
  /** Extra lines printed under the row (a diff, the next steps). */
  lines?: string[]
}

/** A subprocess: `pnpm` for wrangler and the package scripts, `git` for the commit and the tree. */
export interface SetupCmd {
  command: 'pnpm' | 'git'
  args: string[]
  /** `package` is `packages/server-d1` (where wrangler finds `wrangler.jsonc`), `root` the repo root. */
  cwd: 'package' | 'root'
  /** Passed on stdin; never argv. */
  input?: string
  /** Long-running commands (typecheck, tests, deploy) stream their own output. */
  inherit?: boolean
}
export interface ExecResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface Credentials {
  accountId: string
  apiToken: string
}

export interface SetupDeps {
  exec(cmd: SetupCmd): Promise<ExecResult>
  fetch: typeof fetch
  /** Loads the root `.env` and returns the Cloudflare credentials, or throws `RemoteRefusal`. */
  loadEnv(): Credentials
  readConfigText(): string
  writeConfigText(text: string): void
  /** The instance's remote D1 (a platform proxy in the real command). */
  openD1(envName: string): Promise<{ d1: D1Like; dispose(): Promise<void> }>
  readEnvText(): string
  /** Appends `NAME=value` to the root `.env`; throws if it is already set. */
  appendEnvVar(name: string, value: string): void
  log(line: string): void
  now(): number
  sleep(ms: number): Promise<void>
}

export interface SetupOptions {
  env: string
  apiHost: string
  auth: 'none'
  org: string
  origins: string[]
  operatorAgent?: string
  keyEnv?: string
  ownerEmail?: string
  workerName: string
  d1Name: string
  r2Name: string
  only?: StepName[]
  dryRun: boolean
}
