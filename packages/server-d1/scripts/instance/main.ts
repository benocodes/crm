// The commands of `cli/server.js` ([[OPS231]] D12, [[OPS240]] D21): `vibase-server <command>`, the bin of the server package `@vibase/server-d1`.
// It builds the real dependencies (the process, the network, the package's own wrangler) and hands them to the command; `bin.ts` is the process entry.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { D1Like } from '@vibase/storage-d1'
import { runStatus, EXIT_REFUSED } from './status.js'
import { runSetup } from './setup.js'
import { runUpgrade } from './upgrade.js'
import { InstanceRefusal, type InstanceDeps, type RunResult } from './types.js'

export const INSTANCE_HELP = `vibase-server: manage the Vibase instance this server package deploys

  vibase-server status --env <name> [--settings <path>] [--secrets-file <path>]
      Reads the settings and secrets files, verifies this package, asks the live instance
      and prints the upgrade plan. Read-only. Exit 0: the instance is at this release and its
      migrations are current; 1: not (the plan is printed); 2: refused.

  vibase-server upgrade --env <name> [--dry-run] [--rollback] [--settings <path>] [--secrets-file <path>]
      Migrates the instance's database, deploys this package's own Worker and assets, verifies /health and
      runs a read-only smoke. Needs CONFIRM_REMOTE=1 (not for --dry-run, which prints the plan and stops).
      Exit 0: done, or nothing to do; 2: refused before any change; 3: failed after a change began
      (the instance may be partly upgraded: run status, then upgrade again).
      --rollback, run from an OLDER installed release, deploys that release's Worker and runs no migration:
      the database stays at its newer schema. The fast path for a bad deploy is Cloudflare's own
      \`wrangler rollback\` (previous Worker version), with the same warning: it never reverses a migration.

  vibase-server setup --env <name> --api-host <host> [--auth clerk|none] [--owner-email <email>] [--operator-agent <name> --key-env <NAME>]
                        [--dry-run] [--only <steps>] [--settings <path>] [--secrets-file <path>] [more flags: --web-origin, --extra-origin, --org,
                        --worker-name, --d1-name, --r2-name, --clerk-publishable-key, --clerk-production, --no-dcr, --rotate-secrets]
      From nothing, or from an instance deployed from source, to a migrated, bootstrapped, deployed, verified instance, with no checkout:
      preflight, config:resources (adopts existing D1 and R2 by name), clerk, config:write (writes the settings file and goes on), migrate,
      bootstrap, deploy, secrets, verify. Clerk keys, Gmail values and the Cloudflare credentials come from the secrets file; an operator key
      is appended to it as --key-env. Needs CONFIRM_REMOTE=1 (not for --dry-run, which reads only). Refuses a live instance that is newer than
      this package. Exit 0: done, or the dry run is complete; 2: refused before the first step; 3: a step failed (it is named; no later step ran).

  vibase-server --version
      Prints vibase-server/<version> (<commit>) of this package.

Run a pinned version without installing it: npx @vibase/server-d1@<version> <command> ...

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
      let bin: string
      try {
        bin = wranglerBin(packageDir)
      } catch (e) {
        throw new InstanceRefusal(`cannot resolve the wrangler of the installed package at ${packageDir}: ${e instanceof Error ? e.message : 'not found'}: reinstall it`)
      }
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    openD1: async (o) => {
      // The installed package's own wrangler, resolved like its bin (never the repo's, never a global); the module is loaded only here, so no other command pays for it.
      let entry: string
      try {
        entry = createRequire(join(packageDir, 'package.json')).resolve('wrangler')
      } catch (e) {
        throw new InstanceRefusal(`cannot resolve the wrangler of the installed package at ${packageDir}: ${e instanceof Error ? e.message : 'not found'}: reinstall it`)
      }
      const { getPlatformProxy } = (await import(pathToFileURL(entry).href)) as { getPlatformProxy: (o: { configPath: string; persist: false; remoteBindings: true }) => Promise<{ env: { DB: D1Like; CONTROL_DB?: D1Like }; dispose(): Promise<void> }> }
      // The proxy reads the Cloudflare credentials from this process while it lives; they are put back when it is disposed, and never printed.
      const names = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'] as const
      const before = names.map((n) => process.env[n])
      const restore = () => names.forEach((n, i) => (before[i] === undefined ? delete process.env[n] : (process.env[n] = before[i])))
      for (const n of names) process.env[n] = o.env[n]
      try {
        const proxy = await getPlatformProxy({ configPath: o.configPath, persist: o.persist, remoteBindings: o.remoteBindings })
        return { d1: proxy.env.DB, control: proxy.env.CONTROL_DB, dispose: async () => { try { await proxy.dispose() } finally { restore() } } }
      } catch (e) {
        restore()
        throw e
      }
    },
    env: io.env,
    homedir: homedir(),
    tmpRoot: tmpdir(),
    out: (l) => io.stdout(`${l}\n`),
    err: (l) => io.stderr(`${l}\n`),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

/** `vibase-server/<version> (<commit>)` from the `release.json` beside `cli/` ([[OPS240]] D13): one source for the version, the manifest every command verifies against. */
function printVersion(io: { stdout(t: string): void; stderr(t: string): void }, packageDir: string): number {
  try {
    const m = JSON.parse(readFileSync(join(packageDir, 'release.json'), 'utf8')) as { version?: unknown; commit?: unknown }
    if (typeof m.version !== 'string' || typeof m.commit !== 'string') throw new Error('release.json has no version or commit')
    io.stdout(`vibase-server/${m.version} (${m.commit})\n`)
    return 0
  } catch (e) {
    io.stderr(`vibase-server: cannot read the release of ${packageDir}: ${e instanceof Error ? e.message : 'unreadable'}: this is not an installed release package\n`)
    return EXIT_REFUSED
  }
}

/** The words after the program name; returns the exit code. */
export async function runInstance(argv: string[], io: { stdout(t: string): void; stderr(t: string): void; env: Record<string, string | undefined> }, packageDir = fileURLToPath(new URL('..', import.meta.url)), overrides: Partial<InstanceDeps> = {}): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(INSTANCE_HELP)
    return 0
  }
  if (command === '--version') return printVersion(io, packageDir)
  if (command === 'status') return runStatus(rest, { ...realDeps(io, packageDir), ...overrides })
  if (command === 'upgrade') return runUpgrade(rest, { ...realDeps(io, packageDir), ...overrides })
  if (command === 'setup') return runSetup(rest, { ...realDeps(io, packageDir), ...overrides })
  io.stderr(`vibase-server: unknown command "${command}"\n${INSTANCE_HELP}`)
  return EXIT_REFUSED
}
