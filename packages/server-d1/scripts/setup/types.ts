// Shared types of `setup:remote` ([[OPS65]] D6, D7): the step model and the seams the tests fake (command runner, fetch, files, D1).
import type { D1Like } from '@vibase/storage-d1'
import type { HostMode, RecordedHost } from './host.js'
import type { RecordedNames } from './names.js'

export const STEP_NAMES = [
  'preflight',
  'config:resources',
  'clerk',
  'config:write',
  'migrate',
  'bootstrap',
  'deploy',
  'secrets',
  'verify',
] as const
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
  /** Loads the instance's credentials file (`.env.smoked1` for smoked1) and returns the Cloudflare credentials, or throws `RemoteRefusal`. */
  loadEnv(envName: string): Credentials
  readConfigText(): string
  writeConfigText(text: string): void
  /** The instance's remote D1 (a platform proxy in the real command). */
  openD1(envName: string): Promise<{
    d1: D1Like /** `CONTROL_DB`, when the env binds one (OPS279). */
    control?: D1Like
    dispose(): Promise<void>
  }>
  /** The Clerk env file ([[OPS65]] D34): resolves the path (default `.env.<env>` at the repo root), compares real paths with the root `.env`, asks git whether it is ignored, reads it. Never touches `process.env`. */
  probeEnvFile(arg: string | undefined, envName: string): EnvFileProbe
  /** Appends `NAME=value` to the instance's own env file (`.env.<env>`, or `--clerk-env-file`), creating it (mode 600) when it is missing; throws if the name is already there (OPS249 D3). */
  appendEnvFileVar(arg: string | undefined, envName: string, name: string, value: string): void
  readEnvText(): string
  /** Appends `NAME=value` to the root `.env`; throws if it is already set. */
  appendEnvVar(name: string, value: string): void
  log(line: string): void
  now(): number
  sleep(ms: number): Promise<void>
}

export interface SetupOptions {
  env: string
  /** The host of this run ([[OPS308]] P1): the `--api-host` flag, or (with `--workers-dev`) empty until `resolveHost` derives `<worker>.<subdomain>.workers.dev`. */
  apiHost: string
  /** `--workers-dev`: the host is derived from the account's workers.dev subdomain ([[OPS249]] D12). */
  workersDev: boolean
  /** `--register-workers-subdomain <name>`: the explicit, one-time account-wide registration. */
  registerSubdomain?: string
  /** `--change-host`: the operator accepts the consequences of a host change ([[OPS249]] D14). */
  changeHost: boolean
  /** What the instance's record says about its host, when it has a record. */
  recordedHost?: RecordedHost
  /** Set by `resolveHost` when this run changes the host: the record's old host (absent when it was not recorded) and mode. */
  move?: { from?: string; fromMode: HostMode }
  /** A subdomain `--register-workers-subdomain` still has to register: set by `resolveHost`, written by `registerPending` after the preflight, never on a dry run. */
  pendingSubdomain?: string
  /** Lines of the host resolution to print under the header (a registration done or planned). */
  hostNotes?: string[]
  auth: 'better-auth' | 'clerk' | 'none'
  org: string
  origins: string[]
  operatorAgent?: string
  keyEnv?: string
  ownerEmail?: string
  workerName: string
  d1Name: string
  /** The control-plane database ([[CORE259]] D16): `vb-control-<env>` unless a record or `--control-d1-name` says otherwise ([[OPS279]]). */
  controlD1Name: string
  r2Name: string
  /** The names given as flags, before any default or recorded name filled them ([[OPS276]] P3). */
  nameFlags?: { workerName?: string; d1Name?: string; controlD1Name?: string; r2Name?: string }
  only?: StepName[]
  dryRun: boolean
  /** `--clerk-env-file`; default `.env.<env>` at the repo root. */
  clerkEnvFile?: string
  clerkPublishableKey?: string
  clerkProduction: boolean
  noDcr: boolean
  rotateSecrets: boolean
  /** `--replace-instance` ([[OPS250]] D12): the record is set aside; `old` holds the names it recorded (filled by `replaceNames`), only to refuse equal names and to list what is left in place. */
  replace?: { old: RecordedNames }
}
