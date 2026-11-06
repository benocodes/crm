// Pulls an env's Google recordings ([[CHN5]] D78, [[CHN153]]), read-only:
//   CONFIRM_REMOTE=1 pnpm -C packages/server-d1 recordings:pull -- --env <name>
// Same guards as the other remote scripts. `wrangler r2 object` has no list verb, so the recorder keeps `_recordings/index.json` (its entries are the
// keys it wrote); the pull gets that file, then each key it names, with `wrangler r2 object get --remote` only, into the gitignored
// `packages/server-d1/recordings-pull/<env>/`. Nothing is ever put or deleted from here: deleting the objects is the runbook's separate, user-typed step.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unstable_readConfig } from 'wrangler'
import { CONFIG_PATH, PACKAGE_DIR, RemoteRefusal, loadRootEnv, parseEnvFlag, requireConfirm, resolveTarget, type Cmd, type ConfigLike } from './remote.js'

export const PULL_DIR = join(PACKAGE_DIR, 'recordings-pull')
/** The only wrangler verb this script ever runs; a test pins it. */
export const PULL_VERBS: readonly string[] = ['get']
const INDEX_KEY = '_recordings/index.json'

export interface PullDeps {
  loadEnv(): void
  readConfig(envName: string): ConfigLike
  exec(cmd: Cmd): { status: number | null }
  readFile(path: string): string
  mkdir(path: string): void
  log(line: string): void
}

export function bucketOf(config: ConfigLike, envName: string): string {
  const name = config.r2_buckets?.find((b) => b.binding === 'BODIES')?.bucket_name
  if (!name) throw new RemoteRefusal(`env ${envName} has no BODIES bucket`)
  return name
}

/** A key the index may name: under `_recordings/`, plain path segments only (no `..`, no spaces or shell characters). */
export const safeKey = (key: string): boolean => /^_recordings\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(key) && !key.split('/').some((s) => s === '..' || s === '.')

/** The keys the index lists; a key that is not safe refuses the whole pull. */
export function parseIndex(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('the recordings index is not JSON')
  }
  const objects = (parsed as { objects?: unknown } | null)?.objects
  if (!Array.isArray(objects)) throw new Error('the recordings index has no objects list')
  return objects.map((o) => {
    const key = (o as { key?: unknown } | null)?.key
    if (typeof key !== 'string' || !safeKey(key)) throw new Error('the recordings index names an unsafe key')
    return key
  })
}

export const getCommand = (envName: string, bucket: string, key: string, file: string): Cmd => ({
  command: 'pnpm',
  args: ['exec', 'wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--env', envName, '--file', file],
})

export function runPull(argv: string[], procEnv: NodeJS.ProcessEnv, deps: PullDeps): number {
  const envName = parseEnvFlag(argv)
  requireConfirm(procEnv)
  deps.loadEnv()
  const config = deps.readConfig(envName)
  const target = resolveTarget(config, envName)
  const bucket = bucketOf(config, envName)
  deps.log(`target: env ${target.env}, bucket ${bucket} (read-only)`)
  const out = join(PULL_DIR, envName)
  const fetchOne = (key: string, file: string): boolean => {
    deps.mkdir(dirname(file))
    return deps.exec(getCommand(envName, bucket, key, file)).status === 0
  }
  const indexFile = join(out, 'index.json')
  if (!fetchOne(INDEX_KEY, indexFile)) {
    deps.log('no recordings index in the bucket (nothing recorded yet, or the switch was never on); nothing pulled')
    return 1
  }
  const keys = parseIndex(deps.readFile(indexFile))
  for (const key of keys) {
    if (!fetchOne(key, join(out, key.slice('_recordings/'.length)))) {
      deps.log(`could not get ${key}; stopping`)
      return 1
    }
  }
  deps.log(`pulled ${keys.length} recording(s) into ${out}`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = runPull(process.argv.slice(2), process.env, {
      loadEnv: () => loadRootEnv(),
      readConfig: (envName) => unstable_readConfig({ config: CONFIG_PATH, env: envName }) as unknown as ConfigLike,
      exec: (cmd) => ({ status: spawnSync(cmd.command, cmd.args, { cwd: PACKAGE_DIR, stdio: 'inherit', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } }).status }),
      readFile: (p) => readFileSync(p, 'utf8'),
      mkdir: (p) => void mkdirSync(p, { recursive: true }),
      log: (l) => console.log(l),
    })
  } catch (err) {
    console.error(`pull-recordings: ${err instanceof RemoteRefusal || err instanceof Error ? err.message : 'failed'}`)
    process.exitCode = 1
  }
}
