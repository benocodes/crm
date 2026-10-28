// Deploys the Worker to a named instance ([[OPS4]] C6, D3, D12):
//   CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env <name>
// Guards first (env flag, confirmation, clean tree, credentials, target), then typecheck, the suite, and `wrangler deploy
// --env <name> --var VERSION:<sha>` so /health reports the commit that is live.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unstable_readConfig } from 'wrangler'
import { CONFIG_PATH, PACKAGE_DIR, REPO_ROOT, RemoteRefusal, deployCommands, loadRootEnv, parseEnvFlag, requireConfirm, resolveTarget, type ConfigLike } from './remote.js'

const git = (args: string[]) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })

function main(): void {
  const envName = parseEnvFlag(process.argv.slice(2))
  requireConfirm(process.env)
  const status = git(['status', '--porcelain'])
  if (status.status !== 0 || status.stdout.trim() !== '') throw new RemoteRefusal('the working tree is not clean: commit or stash first')
  loadRootEnv()
  const target = resolveTarget(unstable_readConfig({ config: CONFIG_PATH, env: envName }) as unknown as ConfigLike, envName)
  const head = git(['rev-parse', 'HEAD'])
  if (head.status !== 0) throw new RemoteRefusal('could not read the commit (git rev-parse HEAD failed)')
  const sha = head.stdout.trim()
  console.log(`target: env ${target.env}, worker ${target.workerName}, version ${sha}`)
  for (const { command, args } of deployCommands(envName, sha)) {
    const isDeploy = args.includes('deploy')
    const r = spawnSync(command, args, { cwd: isDeploy ? PACKAGE_DIR : REPO_ROOT, stdio: 'inherit', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } })
    if (r.status !== 0) {
      process.exitCode = r.status ?? 1
      return
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (err) {
    if (!(err instanceof RemoteRefusal)) throw err
    console.error(`deploy: ${err.message}`)
    process.exitCode = 1
  }
}
