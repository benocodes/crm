import { serve } from '@hono/node-server'
import { createDb } from '@vault/db'
import { sql } from 'kysely'
import { createApp } from './rest/app.js'

const db = createDb(process.env.DATABASE_URL ?? 'postgresql://vault_app@localhost/vault_dev')
const app = createApp({ db: () => db })
const port = Number(process.env.PORT ?? 8787)

const { rows } = await sql<{ current_database: string }>`SELECT current_database()`.execute(db)
serve({ fetch: app.fetch, port })
console.log(`[dev] listening on http://localhost:${port} (database ${rows[0]!.current_database})`)
