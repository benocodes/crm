// Deploys the Worker to a named instance ([[OPS4]] C6, D3, D12):
//   CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env <name>
// Guards first (env flag, confirmation, clean tree, credentials, target), then typecheck, the suite, and `wrangler deploy
// --env <name> --var VERSION:<sha> --var COMMIT:<sha>` so /health reports the commit that is live.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unstable_readConfig } from 'wrangler'
import {
  CONFIG_PATH,
  PACKAGE_DIR,
  REPO_ROOT,
  RemoteRefusal,
  deployCommands,
  loadRemoteEnv,
  parseEnvFlag,
  requireConfirm,
  requireControlTarget,
  type Cmd,
  type ConfigLike,
} from './remote.js'

const git = (args: string[]) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })

export interface DeployDeps {
  git(args: string[]): { status: number | null; stdout: string }
  loadEnv(envName: string): void
  readConfig(envName: string): ConfigLike
  /** Runs one command; returns its exit status. */
  run(cmd: Cmd): number | null
  log(line: string): void
}

export const realDeployDeps: DeployDeps = {
  git,
  loadEnv: (envName) => loadRemoteEnv(envName),
  readConfig: (envName) => unstable_readConfig({ config: CONFIG_PATH, env: envName }) as unknown as ConfigLike,
  run: ({ command, args }) =>
    spawnSync(command, args, {
      cwd: args.includes('deploy') ? PACKAGE_DIR : REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    }).status,
  log: (line) => console.log(line),
}

/** The clean-tree guard of the deploy, shared with `auth:migrate:remote apply` ([[OPS393]] 393.15): no bypass. */
export function requireCleanTree(git: DeployDeps['git'], hint = 'commit or stash first'): void {
  const status = git(['status', '--porcelain'])
  if (status.status !== 0 || status.stdout.trim() !== '')
    throw new RemoteRefusal(`the working tree is not clean: ${hint}`)
}

/** The guarded deploy as a function a test can call: returns the exit code; a refusal throws `RemoteRefusal` before any command runs. */
export function runDeploy(argv: string[], procEnv: NodeJS.ProcessEnv, deps: DeployDeps): number {
  const envName = parseEnvFlag(argv)
  requireConfirm(procEnv)
  requireCleanTree(deps.git)
  deps.loadEnv(envName)
  // [[CORE326]] P4: a Worker without its control database answers 500 on every request, so the deploy is refused before the build.
  const target = requireControlTarget(deps.readConfig(envName), envName)
  const head = deps.git(['rev-parse', 'HEAD'])
  if (head.status !== 0) throw new RemoteRefusal('could not read the commit (git rev-parse HEAD failed)')
  const sha = head.stdout.trim()
  deps.log(`target: env ${target.env}, worker ${target.workerName}, version ${sha}`)
  for (const cmd of deployCommands(envName, sha)) {
    const status = deps.run(cmd)
    if (status !== 0) return status ?? 1
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = runDeploy(process.argv.slice(2), process.env, realDeployDeps)
  } catch (err) {
    if (!(err instanceof RemoteRefusal)) throw err
    console.error(`deploy: ${err.message}`)
    process.exitCode = 1
  }
}
