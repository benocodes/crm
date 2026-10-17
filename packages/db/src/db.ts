import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './types.js'

/**
 * A Kysely instance over a fresh pool. No module-level instance: the caller owns it and
 * `destroy()`s it. `connectionTimeoutMillis` stops a Node pool hanging on a dead connection.
 */
export function createDb(connectionString: string, options: { max?: number } = {}): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
        max: options.max ?? 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 2_000,
      }),
    }),
  })
}
