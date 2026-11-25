// The generated wrangler config ([[OPS210]] D11, [[OPS231]]): the release's base config plus the settings file, written per run into a fresh temp
// directory and deleted afterwards. It holds no secret. `resolveTarget`'s refusals ([[OPS4]] C4) apply to it before it is written.
import { copyFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { RemoteRefusal, resolveTarget } from '../remote.js'
import { isWorkersDevHost } from '../setup/host.js'
import { EMPTY_SCHEMA_FILE, SCHEMA_FILE_MODULE } from './schema-file.js'
import type { InstanceSettings } from './types.js'

export interface InstalledPaths {
  worker: string
  assets: string
  migrations: string
  controlMigrations: string
}

export function generateConfig(
  base: Record<string, any>,
  settings: InstanceSettings,
  paths: InstalledPaths,
): Record<string, any> {
  const { env: _env, ...top } = base
  const workflow = (top.workflows?.[0] ?? { binding: 'MAIL_SYNC', class_name: 'MailSyncWorkflow' }) as {
    binding: string
    class_name: string
  }
  return {
    ...top,
    name: settings.worker,
    main: paths.worker,
    assets: { ...top.assets, directory: paths.assets },
    workers_dev: settings.workers_dev === true,
    preview_urls: false,
    // A workers.dev host has no route ([[OPS308]] D12); a custom one (also after a move, which keeps workers_dev) has its custom_domain route.
    ...(isWorkersDevHost(settings.api_host) ? {} : { routes: [{ pattern: settings.api_host, custom_domain: true }] }),
    // By binding, from the recorded values only ([[OPS275]] D16): the control entry is present exactly when the settings record one.
    d1_databases: [
      {
        binding: 'DB',
        database_name: settings.d1.name,
        database_id: settings.d1.id,
        migrations_dir: paths.migrations,
        remote: true,
      },
      ...(settings.control_d1
        ? [
            {
              binding: 'CONTROL_DB',
              database_name: settings.control_d1.name,
              database_id: settings.control_d1.id,
              migrations_dir: paths.controlMigrations,
              remote: true,
            },
          ]
        : []),
    ],
    r2_buckets: [{ binding: 'BODIES', bucket_name: settings.r2_bucket }],
    workflows: [{ binding: workflow.binding, name: settings.workflow.name, class_name: workflow.class_name }],
    triggers: { crons: settings.crons ?? top.triggers?.crons ?? [] },
    vars: settings.vars,
    // [[CORE315]] D27: the schema file is a Text module staged beside the Worker; `--no-bundle` attaches it by this rule.
    rules: [{ type: 'Text', globs: [SCHEMA_FILE_MODULE], fallthrough: true }],
  }
}

interface ConfigOptions {
  packageDir: string
  settings: InstanceSettings
  tmpRoot: string
  /** `setup` ([[OPS232]]): the config of the calls that exist before the database does (`d1 list`, `d1 create`, `r2 bucket ...`) may carry the placeholder id; the worker name is still checked. */
  resourcesOnly?: boolean
  /** The bytes of the schema module the deploy attaches ([[CORE543]] D27); absent, the empty declaration. Staged beside the Worker in the temp directory, never into the package. */
  schemaFile?: Uint8Array
}

function writeConfig(o: ConfigOptions): { dir: string; path: string } {
  const base = parse(readFileSync(join(o.packageDir, 'wrangler.base.jsonc'), 'utf8')) as Record<string, any>
  const dir = mkdtempSync(join(o.tmpRoot, 'vibase-instance-'))
  try {
    // [[CORE543]] D27: the package's `worker.js` is copied beside the module, because wrangler attaches a Text module from the directory of the Worker and the package's own files are never modified.
    copyFileSync(join(o.packageDir, 'worker', 'worker.js'), join(dir, 'worker.js'))
    writeFileSync(join(dir, SCHEMA_FILE_MODULE), o.schemaFile ?? EMPTY_SCHEMA_FILE)
    const config = generateConfig(base, o.settings, {
      worker: join(dir, 'worker.js'),
      assets: join(o.packageDir, 'assets'),
      migrations: join(o.packageDir, 'migrations'),
      controlMigrations: join(o.packageDir, 'control-migrations'),
    })
    if (o.resourcesOnly) {
      if (config.name === 'vb') throw new RemoteRefusal(`unknown env ${o.settings.env}`)
    } else resolveTarget(config, o.settings.env)
    const path = join(dir, 'wrangler.jsonc')
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    return { dir, path }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
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
export async function withGeneratedConfigAsync<T>(
  o: ConfigOptions,
  fn: (configPath: string) => Promise<T>,
): Promise<T> {
  const { dir, path } = writeConfig(o)
  try {
    return await fn(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
