import { createMigrator } from './src/migrator.js'

const url = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://localhost/vault_dev'
const { db, migrator } = createMigrator(url)

async function main() {
  try {
    const { results, error } = await migrator.migrateToLatest()
    results?.forEach((it) => {
      if (it.status === 'Success') console.log(`↑ ${it.migrationName} applied`)
      else if (it.status === 'Error') console.error(`↑ ${it.migrationName} failed`)
    })
    if (error) {
      console.error('Migration failed:', error)
      process.exitCode = 1
      return
    }
    if (!results?.length) console.log('Already up to date')
  } finally {
    await db.destroy()
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((err) => {
  console.error(err)
  process.exit(1)
})
