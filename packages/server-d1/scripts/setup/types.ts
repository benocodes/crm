// Shared types of `setup:remote` ([[OPS65]] D6, D7): the step model and the seams the tests fake (command runner, fetch, files, D1).
import type { D1Like } from '@vibase/storage-d1'

export const STEP_NAMES = ['preflight', 'config:resources', 'clerk', 'config:write', 'migrate', 'bootstrap', 'deploy', 'secrets', 'verify'] as const
/** Steps that exist only with `--auth clerk` ([[OPS65]] D11); `secrets` also runs on `--auth none` for the Gmail group ([[OPS65]] D41). */
export const CLERK_ONLY_STEPS: readonly StepName[] = ['clerk']
export type StepName = (typeof STEP_NAMES)[number]

/** `blocked` is this cycle's addition to the spec's five: a step that cannot be evaluated until an earlier planned change lands (a dry run's later steps). It never fails the run. */
export type Status = 'ok' | 'create' | 'update' | 'manual' | 'fail' | 'blocked'

export interface StepResult {
  step: StepName
  status: Status
  detail: string
  /** Extra lines printed under the row (a diff, the next steps). */
  lines?: string[]
  /** Dashboard items the command cannot do or check (the Clerk rows marked `manual`): listed last and again in verify's next steps ([[OPS65]] D8, D21). */
  manual?: string[]
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

export interface EnvFileProbe {
  /** The path as shown to the owner (never a value). */
  display: string
  status: 'ok' | 'root-env' | 'missing' | 'not-ignored'
  /** The file's text; present only when `status` is `ok`. */
  text?: string
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
  /** The Clerk env file ([[OPS65]] D34): resolves the path (default `.env.<env>` at the repo root), compares real paths with the root `.env`, asks git whether it is ignored, reads it. Never touches `process.env`. */
  probeEnvFile(arg: string | undefined, envName: string): EnvFileProbe
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
  auth: 'none' | 'clerk'
  org: string
  origins: string[]
  operatorAgent?: string
  keyEnv?: string
  ownerEmail?: string
  workerName: string
  d1Name: string
  r2Name: string
  /** The names given as flags, before any default or recorded name filled them ([[OPS276]] P3). */
  nameFlags?: { workerName?: string; d1Name?: string; r2Name?: string }
  only?: StepName[]
  dryRun: boolean
  /** `--clerk-env-file`; default `.env.<env>` at the repo root. */
  clerkEnvFile?: string
  clerkPublishableKey?: string
  clerkProduction: boolean
  noDcr: boolean
  rotateSecrets: boolean
}
