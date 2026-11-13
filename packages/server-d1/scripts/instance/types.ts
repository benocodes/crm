// Shared types of the `vibase instance` commands ([[OPS231]]). Everything that touches the world comes in through `InstanceDeps`, so a test passes fakes.
import type { D1Like } from '@vault/storage-d1'

/** A refusal: printed as `vibase instance <command>: <message>` and exit 2. A message names a key or a path, never a secret value. */
export class InstanceRefusal extends Error {}

export interface InstanceSettings {
  version: 1
  env: string
  worker: string
  api_host: string
  d1: { name: string; id: string }
  r2_bucket: string
  /** The Gmail sync Workflow's instance name; binding `MAIL_SYNC` and class `MailSyncWorkflow` come from the release's base config. */
  workflow: { name: string }
  vars: Record<string, string>
  crons?: string[]
}

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface OpenD1Options {
  configPath: string
  remoteBindings: true
  persist: false
  env: Record<string, string>
}

export interface InstanceDeps {
  /** The installed package directory (`<package>/cli/instance.js` lives in `<package>/cli`). */
  packageDir: string
  fetch: typeof fetch
  /** Runs the package's own wrangler with `args` (never a global, never `pnpm exec`). `env` is the whole child environment; `input` goes on stdin (`secret bulk`), never argv. */
  runWrangler(args: string[], opts: { cwd: string; env: Record<string, string>; input?: string }): RunResult
  /** `setup`'s bootstrap ([[OPS232]] P3): the instance's remote D1 through the installed package's own wrangler `getPlatformProxy`, on the generated config. `env` carries the two Cloudflare values. */
  openD1(o: OpenD1Options): Promise<{ d1: D1Like; dispose(): Promise<void> }>
  /** The process environment (XDG_CONFIG_HOME, CLOUDFLARE_*, PATH, HOME). */
  env: Record<string, string | undefined>
  homedir: string
  /** Where the generated wrangler config's temp directory is made. */
  tmpRoot: string
  out(line: string): void
  err(line: string): void
  /** The clock of the verify loop ([[OPS234]]): injected so a test never waits for real. */
  now(): number
  sleep(ms: number): Promise<void>
}

/** A refusal of either kind: `InstanceRefusal`, or `RemoteRefusal` from `resolveTarget` / `requireConfirm` (it has its own class in `remote.ts`). */
export const isRefusal = (e: unknown): e is Error => e instanceof InstanceRefusal || (e instanceof Error && e.name === 'RemoteRefusal')
