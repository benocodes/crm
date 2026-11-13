import { serve } from '@hono/node-server'
import { createDb } from '@vibase/db'
import { sql } from 'kysely'
import { createApp, createAuthAdapter, parseOriginList } from '@vibase/api'
import { postgresBinding } from '@vibase/storage-postgres'

const db = createDb(process.env.DATABASE_URL ?? 'postgresql://vault_app@localhost/vault_dev')
const authAdapter = createAuthAdapter(process.env)
const corsOrigins = parseOriginList(process.env.CORS_ALLOWED_ORIGINS, 'CORS_ALLOWED_ORIGINS')
// Composition code: picks the Postgres runtime (enterprise tier, [[CORE36]] D22).
const storage = postgresBinding(db)
const app = createApp({ authAdapter, corsOrigins, storage: () => storage })
const port = Number(process.env.PORT ?? 8787)

const { rows } = await sql<{ current_database: string }>`SELECT current_database()`.execute(db)
serve({ fetch: app.fetch, port })
console.log(`[dev] listening on http://localhost:${port} (database ${rows[0]!.current_database}, auth ${authAdapter?.provider ?? 'none'})`)
