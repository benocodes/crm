import { Kysely, PostgresDialect, SqliteDialect, sql, type RawBuilder } from 'kysely'
import { tasks, contacts, identities } from '@vault/api'
import type { PreparedOperation, Statement } from './types.js'
export type Expr = RawBuilder<unknown>
export const raw = (s: string) => sql.raw(s)
/** A syntax kit only: all business predicates remain in the two operation definitions. */
export class SqlKit {
  readonly db: Kysely<any>
  readonly operations: string
  readonly rows: string
  readonly statements: Statement[] = []
  constructor(
    readonly dialect: 'postgres' | 'd1',
    readonly op: PreparedOperation<any>,
  ) {
    const reject = async (): Promise<never> => {
      throw new Error('compile-only driver invoked')
    }
    this.db = new Kysely<any>({
      dialect:
        dialect === 'postgres'
          ? new PostgresDialect({ pool: reject })
          : new SqliteDialect({ database: reject }),
    })
    this.operations = dialect === 'postgres' ? 'storage_prototype.operations' : 'prototype_operations'
    this.rows = dialect === 'postgres' ? 'storage_prototype.rows' : 'prototype_rows'
  }
  value(v: unknown, type?: 'uuid' | 'timestamp' | 'json'): Expr {
    const b = sql`${v}`
    if (this.dialect === 'postgres' && type)
      return sql`${b}::${raw({ uuid: 'uuid', timestamp: 'timestamptz', json: 'jsonb' }[type])}`
    return type === 'json' ? sql`json(${b})` : b
  }
  field(doc: string, key: string, type: 'text' | 'uuid' | 'integer' | 'json' = 'text'): Expr {
    if (this.dialect === 'postgres') {
      const extracted = sql`${raw(doc)} ${raw(type === 'json' ? '->' : '->>')} ${sql.lit(key)}`
      return type === 'uuid'
        ? sql`(${extracted})::uuid`
        : type === 'integer'
          ? sql`(${extracted})::integer`
          : extracted
    }
    return sql`json_extract(${raw(doc)}, ${sql.lit('$.' + key)})`
  }
  object(fields: Record<string, Expr>): Expr {
    return sql`${raw(this.dialect === 'postgres' ? 'jsonb_build_object' : 'json_object')}(${sql.join(Object.entries(fields).flatMap(([k, v]) => [sql.lit(k), v]))})`
  }
  json(v: Expr): Expr {
    return this.dialect === 'postgres' ? v : sql`json(${v})`
  }
  boolean(v: Expr): Expr {
    return this.dialect === 'postgres' ? v : sql`json(CASE WHEN ${v} THEN 'true' ELSE 'false' END)`
  }
  timestamp(v: Expr): Expr {
    return this.dialect === 'postgres'
      ? sql`to_char(${v} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
      : v
  }
  now(): Expr {
    return raw(this.dialect === 'postgres' ? 'now()' : "strftime('%Y-%m-%dT%H:%M:%fZ','now')")
  }
  project(resource: 'tasks' | 'contacts' | 'identities', alias: string): Expr {
    const shape = { tasks, contacts, identities }[resource].record.shape
    return this.object(
      Object.fromEntries(
        Object.keys(shape).map((key) => {
          let v: Expr = raw(`${alias}.${key}`)
          if (key.endsWith('_at')) v = this.timestamp(v)
          if (key === 'own') v = this.boolean(v)
          return [key, v]
        }),
      ),
    )
  }
  entries(): Expr {
    const input = sql`(SELECT input FROM ${raw(this.operations)} WHERE id=${this.value(this.op.operationId, 'uuid')})`
    return this.dialect === 'postgres'
      ? sql`jsonb_array_elements(${input}->'entries') AS entry(value)`
      : sql`json_each(${input},'$.entries') AS entry`
  }
  add(label: string, query: Expr) {
    const q = query.compile(this.db)
    this.statements.push({ label, sql: q.sql, parameters: [...q.parameters] })
  }
  scratch(payload: Expr, source: Expr, slot: string, ordinal: Expr, id: Expr) {
    const o = this.op
    return sql`INSERT INTO ${raw(this.rows)} (id,organization_id,actor_id,created_at,operation_id,slot,ordinal,payload)
 SELECT ${id},${this.value(o.context.organizationId, 'uuid')},${this.value(o.context.actor.id, 'uuid')},${this.now()},${this.value(o.operationId, 'uuid')},${sql.lit(slot)},${ordinal},${payload} ${source}`
  }
  scope(alias = 's'): Expr {
    return sql`${raw(alias + '.operation_id')}=${this.value(this.op.operationId, 'uuid')}`
  }
  begin() {
    const o = this.op
    this.add(
      'begin',
      sql`INSERT INTO ${raw(this.operations)} (id,organization_id,actor_id,created_at,input) VALUES(${this.value(o.operationId, 'uuid')},${this.value(o.context.organizationId, 'uuid')},${this.value(o.context.actor.id, 'uuid')},${this.now()},${this.value(JSON.stringify(o.input), 'json')})`,
    )
  }
  cleanup() {
    this.add(
      'cleanup',
      sql`DELETE FROM ${raw(this.rows)} WHERE operation_id=${this.value(this.op.operationId, 'uuid')}`,
    )
    this.add(
      'cleanup',
      sql`DELETE FROM ${raw(this.operations)} WHERE id=${this.value(this.op.operationId, 'uuid')}`,
    )
  }
  event(
    label: string,
    id: Expr,
    resource: string,
    action: string,
    rid: Expr,
    before: Expr,
    after: Expr,
    from: Expr,
  ) {
    const o = this.op
    this.add(
      label,
      sql`INSERT INTO events (id,organization_id,actor_id,created_at,type,resource_type,resource_id,"before","after") SELECT ${id},${this.value(o.context.organizationId, 'uuid')},${this.value(o.context.actor.id, 'uuid')},${this.now()},${sql.lit(resource + '.' + action)},${sql.lit(resource)},${rid},${before},${after} ${from}`,
    )
  }
}
