import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { embedJson, queryContext, type EmbedSpec } from './index.js'

const spec: EmbedSpec = {
  table: 'message_attachments',
  key: 'message_id',
  columns: ['id', 'position', 'type', 'size_bytes', 'inline', 'fetch_status', 'file_id'],
  orderBy: ['position'],
}
const compile = (dialect: 'postgres' | 'd1', s: EmbedSpec, ctx: 'select' | 'json') => {
  const qc = queryContext(dialect)
  return sql`select ${embedJson(qc, 'messages', s, ctx)}`.compile(qc.db).sql
}

describe('embedJson (CORE25 D50, P8)', () => {
  it('Postgres: an ordered jsonb_agg, [] when empty, correlated on the key and the organisation', () => {
    const q = compile('postgres', spec, 'select')
    expect(q).toContain('coalesce(')
    expect(q).toContain('jsonb_agg(')
    expect(q).toContain('jsonb_build_object(')
    expect(q).toMatch(/order by "message_attachments"\."position"/i)
    expect(q).toContain('"message_attachments"."message_id" = "messages"."id"')
    expect(q).toContain('"message_attachments"."organization_id" = "messages"."organization_id"')
    expect(q).toContain("'[]'")
  })

  it('D1, select context: json_group_array(json_object(...) ORDER BY ...), booleans through iif', () => {
    const q = compile('d1', spec, 'select')
    expect(q).toContain('json_group_array(json_object(')
    expect(q).toMatch(/order by "message_attachments"\."position"/i)
    expect(q).toContain(`json(iif("message_attachments"."inline", 'true', 'false'))`)
    expect(q).toContain('"message_attachments"."message_id" = "messages"."id"')
  })

  it('D1, json context: wrapped in json( so it nests as JSON, not text', () => {
    const q = compile('d1', spec, 'json')
    expect(q).toMatch(/json\(\(select json_group_array/)
  })

  it('refuses a column that is not in COLUMN_KINDS of the child table', () => {
    expect(() => compile('postgres', { ...spec, columns: ['bogus'] }, 'select')).toThrow(/bogus/)
  })
})
