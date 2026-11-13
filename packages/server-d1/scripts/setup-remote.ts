// One guarded, idempotent command from nothing to a migrated, bootstrapped, deployed, verified instance ([[OPS65]] D6):
//   CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env <name> --api-host <host> --owner-email <email> [flags]   (--auth clerk is the default)
//   CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env <name> --auth none --api-host <host> [flags]            (API keys only)
//   pnpm -C packages/server-d1 setup:remote -- --env <name> --api-host <host> --owner-email <email> --dry-run                   (reads only)
// The steps and their guards live in scripts/setup/; this file only wires the real wrangler, git, fetch, files and D1.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Like } from '@vibase/storage-d1'
import { appendEnvVar, remoteProxyOptions } from './bootstrap.js'
import { CONFIG_PATH, PACKAGE_DIR, REPO_ROOT, ROOT_ENV_PATH, loadRootEnv } from './remote.js'
import { probeEnvFile } from './setup/env-file.js'
import { runSetup } from './setup/run.js'
import type { SetupDeps } from './setup/types.js'

export const realSetupDeps: SetupDeps = {
  exec: async (cmd) => {
    const r = spawnSync(cmd.command, cmd.args, {
      cwd: cmd.cwd === 'package' ? PACKAGE_DIR : REPO_ROOT,
      encoding: 'utf8',
      input: cmd.input,
      stdio: cmd.inherit ? ['ignore', 'inherit', 'inherit'] : undefined,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  },
  fetch: (input, init) => fetch(input, init),
  loadEnv: () => {
    loadRootEnv()
    return { accountId: process.env.CLOUDFLARE_ACCOUNT_ID!, apiToken: process.env.CLOUDFLARE_API_TOKEN! }
  },
  readConfigText: () => readFileSync(CONFIG_PATH, 'utf8'),
  writeConfigText: (text) => writeFileSync(CONFIG_PATH, text),
  openD1: async (envName) => {
    const { getPlatformProxy } = await import('wrangler')
    const proxy = await getPlatformProxy<{ DB: D1Like; CONTROL_DB?: D1Like }>(remoteProxyOptions(envName))
    return { d1: proxy.env.DB, control: proxy.env.CONTROL_DB, dispose: () => proxy.dispose() }
  },
  probeEnvFile: (arg, envName) => probeEnvFile(arg, envName, REPO_ROOT, ROOT_ENV_PATH),
  readEnvText: () => {
    try {
      return readFileSync(ROOT_ENV_PATH, 'utf8')
    } catch {
      return ''
    }
  },
  appendEnvVar: (name, value) => writeFileSync(ROOT_ENV_PATH, appendEnvVar(realSetupDeps.readEnvText(), name, value)),
  log: (line) => console.log(line),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = (await runSetup(process.argv.slice(2), process.env, realSetupDeps)).exitCode
  } catch (err) {
    console.error(`setup: ${err instanceof Error ? err.message : 'failed'}`)
    process.exitCode = 1
  }
}
