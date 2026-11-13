// The entry of `cli/instance.js` ([[OPS231]] D12): `vibase instance <command>`, loaded by the client CLI from beside itself in a release package.
// It builds the real dependencies (the process, the network, the package's own wrangler) and hands them to the command.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runStatus, EXIT_REFUSED } from './status.js'
import type { InstanceDeps, RunResult } from './types.js'

export const INSTANCE_HELP = `vibase instance: manage the vault instance this release package deploys

  vibase instance status --env <name> [--settings <path>] [--secrets-file <path>]
      Reads the settings and secrets files, verifies this package, asks the live instance
      and prints the upgrade plan. Read-only. Exit 0: the instance is at this release and its
      migrations are current; 1: not (the plan is printed); 2: refused.

Settings: $XDG_CONFIG_HOME/vibase/instances/<env>.json (~/.config when unset)
Secrets:  <env>.env beside it, mode 600, with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
`

/** The wrangler this package depends on: resolved from the installed package's own dependency tree, never a global and never `pnpm exec`. */
export function wranglerBin(packageDir: string): string {
  const req = createRequire(join(packageDir, 'package.json'))
  const pkgPath = req.resolve('wrangler/package.json')
  const bin = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> }).bin
  const rel = typeof bin === 'string' ? bin : bin?.wrangler
  if (!rel) throw new Error('the installed wrangler has no bin')
  return join(dirname(pkgPath), rel)
}

export function realDeps(io: { stdout(t: string): void; stderr(t: string): void; env: Record<string, string | undefined> }, packageDir: string): InstanceDeps {
  return {
    packageDir,
    fetch,
    runWrangler: (args, opts): RunResult => {
      const r = spawnSync(process.execPath, [wranglerBin(packageDir), ...args], { cwd: opts.cwd, env: opts.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    env: io.env,
    homedir: homedir(),
    tmpRoot: tmpdir(),
    out: (l) => io.stdout(`${l}\n`),
    err: (l) => io.stderr(`${l}\n`),
  }
}

/** The words after `instance`; returns the exit code. */
export async function runInstance(argv: string[], io: { stdout(t: string): void; stderr(t: string): void; env: Record<string, string | undefined> }, packageDir = fileURLToPath(new URL('..', import.meta.url))): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(INSTANCE_HELP)
    return 0
  }
  if (command === 'status') return runStatus(rest, realDeps(io, packageDir))
  io.stderr(`vibase instance: unknown command "${command}"\n${INSTANCE_HELP}`)
  return EXIT_REFUSED
}

export default runInstance
