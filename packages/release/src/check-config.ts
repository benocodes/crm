// The wrangler config `release:check` runs the installed package with ([[OPS260]] D14, D16): the package's own base config with its paths pointed into the installed directory, and each
// `d1_databases` entry given the migrations directory of ITS binding (`DB` -> `migrations/`, `CONTROL_DB` -> `control-migrations/`). Mapping both to one directory would apply the CRM
// schema to the control database, which a Worker on the real two-database layout would then refuse; distinct ids matter because local wrangler and Miniflare key the SQLite file by `database_id`.
import { join } from 'node:path'
import { ReleaseRefusal } from './errors.js'

const DIRECTORY: Readonly<Record<string, string>> = { DB: 'migrations', CONTROL_DB: 'control-migrations' }
const NAME: Readonly<Record<string, string>> = { DB: 'vb-crm', CONTROL_DB: 'vb-control' }

export function checkConfig(base: Record<string, any>, installedDir: string): Record<string, unknown> {
  const entries = (base.d1_databases ?? []) as Array<Record<string, unknown>>
  for (const d of entries) if (!(String(d.binding) in DIRECTORY)) throw new ReleaseRefusal(`the base config binds ${String(d.binding)}, which has no migrations directory (expected only DB and CONTROL_DB)`)
  for (const binding of Object.keys(DIRECTORY)) {
    const d = entries.find((e) => e.binding === binding)
    if (!d) throw new ReleaseRefusal(`the base config has no ${binding} d1_databases entry`)
    if (d.database_name !== NAME[binding]) throw new ReleaseRefusal(`the base config's ${binding} database is named ${JSON.stringify(d.database_name)}, expected ${NAME[binding]}`)
  }
  const ids = entries.map((d) => d.database_id)
  if (new Set(ids).size !== ids.length) throw new ReleaseRefusal('the base config\'s d1_databases entries must have distinct database_ids (local wrangler keys the database file by id: a shared id is one database)')
  return {
    ...base,
    main: join(installedDir, 'worker', 'worker.js'),
    assets: { ...base.assets, directory: join(installedDir, 'assets') },
    d1_databases: entries.map((d) => ({ ...d, migrations_dir: join(installedDir, DIRECTORY[String(d.binding)]!) })),
  }
}
