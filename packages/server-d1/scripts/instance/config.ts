// The generated wrangler config ([[OPS210]] D11, [[OPS231]]): the release's base config plus the settings file, written per run into a fresh temp
// directory and deleted afterwards. It holds no secret. `resolveTarget`'s refusals ([[OPS4]] C4) apply to it before it is written.
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { RemoteRefusal, resolveTarget } from '../remote.js'
import type { InstanceSettings } from './types.js'

export interface InstalledPaths {
  worker: string
  assets: string
  migrations: string
}

export function generateConfig(base: Record<string, any>, settings: InstanceSettings, paths: InstalledPaths): Record<string, any> {
  const { env: _env, ...top } = base
  const workflow = (top.workflows?.[0] ?? { binding: 'MAIL_SYNC', class_name: 'MailSyncWorkflow' }) as { binding: string; class_name: string }
  return {
    ...top,
    name: settings.worker,
    main: paths.worker,
    assets: { ...top.assets, directory: paths.assets },
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: settings.api_host, custom_domain: true }],
    d1_databases: [{ binding: 'DB', database_name: settings.d1.name, database_id: settings.d1.id, migrations_dir: paths.migrations, remote: true }],
    r2_buckets: [{ binding: 'BODIES', bucket_name: settings.r2_bucket }],
    workflows: [{ binding: workflow.binding, name: settings.workflow.name, class_name: workflow.class_name }],
    triggers: { crons: settings.crons ?? top.triggers?.crons ?? [] },
    vars: settings.vars,
  }
}

interface ConfigOptions {
  packageDir: string
  settings: InstanceSettings
  tmpRoot: string
  /** `setup` ([[OPS232]]): the config of the calls that exist before the database does (`d1 list`, `d1 create`, `r2 bucket ...`) may carry the placeholder id; the worker name is still checked. */
  resourcesOnly?: boolean
}

function writeConfig(o: ConfigOptions): { dir: string; path: string } {
  const base = parse(readFileSync(join(o.packageDir, 'wrangler.base.jsonc'), 'utf8')) as Record<string, any>
  const config = generateConfig(base, o.settings, { worker: join(o.packageDir, 'worker', 'worker.js'), assets: join(o.packageDir, 'assets'), migrations: join(o.packageDir, 'migrations') })
  if (o.resourcesOnly) {
    if (config.name === 'vault') throw new RemoteRefusal(`unknown env ${o.settings.env}`)
  } else resolveTarget(config, o.settings.env)
  const dir = mkdtempSync(join(o.tmpRoot, 'vibase-instance-'))
  const path = join(dir, 'wrangler.jsonc')
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return { dir, path }
}

/** Writes the generated config into a fresh temp directory, runs `fn` with its path, and deletes the directory afterwards, on success and on failure. */
export function withGeneratedConfig<T>(o: ConfigOptions, fn: (configPath: string) => T): T {
  const { dir, path } = writeConfig(o)
  try {
    return fn(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The same for a callback that lives across awaits (`setup`'s bootstrap holds the config while the remote D1 proxy is open). */
export async function withGeneratedConfigAsync<T>(o: ConfigOptions, fn: (configPath: string) => Promise<T>): Promise<T> {
  const { dir, path } = writeConfig(o)
  try {
    return await fn(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
