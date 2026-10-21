import { sql } from 'kysely'
import { SqlKit, raw } from '../sql-kit.js'
export function resolveIdentitiesProgram(k: SqlKit) {
  const org = k.value(k.op.context.organizationId, 'uuid'),
    actor = k.value(k.op.context.actor.id, 'uuid')
  const f = (key: string, type: 'text' | 'uuid' | 'integer' | 'json' = 'text') =>
    k.field('entry.value', key, type)
  // First ordinal is captured once; all insert predicates reuse the same decision rows.
  const ranked = sql`SELECT entry.value, row_number() OVER(PARTITION BY ${f('kind')},${f('value')} ORDER BY ${f('ordinal', 'integer')}) AS occurrence FROM ${k.entries()}`
  const payload = k.object({
    kind: f('kind'),
    value: f('value'),
    name: f('name'),
    candidate_cid: f('cid'),
    cid: sql`COALESCE(i.contact_id,${f('cid', 'uuid')})`,
    iid: sql`COALESCE(i.id,${f('iid', 'uuid')})`,
    ceid: f('ceid'),
    ieid: f('ieid'),
    missing: k.boolean(sql`i.id IS NULL`),
  })
  k.add(
    'snapshot',
    k.scratch(
      payload,
      sql`FROM (${ranked}) entry LEFT JOIN identities i ON i.organization_id=${org} AND i.kind=${f('kind')} AND i.value=${f('value')} AND i.deleted_at IS NULL WHERE entry.occurrence=1`,
      'decision',
      f('ordinal', 'integer'),
      f('rid', 'uuid'),
    ),
  )
  const d = (key: string, type: 'text' | 'uuid' | 'integer' | 'json' = 'text') =>
    k.field('s.payload', key, type)
  const decisions = sql`FROM ${raw(k.rows)} s WHERE ${k.scope()} AND s.slot='decision' AND ${d('missing', k.dialect === 'postgres' ? 'text' : 'integer')}=${k.dialect === 'postgres' ? sql.lit('true') : raw('1')}`
  k.add(
    'first-mutation',
    sql`INSERT INTO contacts(id,organization_id,created_by,created_at,updated_at,name) SELECT ${d('cid', 'uuid')},${org},${actor},${k.now()},${k.now()},${d('name')} ${decisions}`,
  )
  k.add(
    'mutation',
    sql`INSERT INTO identities(id,organization_id,created_by,created_at,updated_at,kind,value,contact_id,own) SELECT ${d('iid', 'uuid')},${org},${actor},${k.now()},${k.now()},${d('kind')},${d('value')},${d('cid', 'uuid')},${raw('false')} ${decisions}`,
  )
  const join = sql`FROM ${raw(k.rows)} s JOIN identities i ON i.id=${d('iid', 'uuid')} LEFT JOIN contacts c ON c.id=i.contact_id AND c.organization_id=i.organization_id WHERE ${k.scope()} AND s.slot='decision' AND ${d('missing', k.dialect === 'postgres' ? 'text' : 'integer')}=${k.dialect === 'postgres' ? sql.lit('true') : raw('1')}`
  k.event(
    'first-event',
    d('ceid', 'uuid'),
    'contact',
    'created',
    d('cid', 'uuid'),
    raw('NULL'),
    k.project('contacts', 'c'),
    join,
  )
  k.event(
    'event',
    d('ieid', 'uuid'),
    'identity',
    'created',
    d('iid', 'uuid'),
    raw('NULL'),
    k.project('identities', 'i'),
    join,
  )
  const result = k.object({
    identity: k.project('identities', 'i'),
    contact: sql`CASE WHEN i.contact_id IS NULL THEN NULL ELSE ${k.project('contacts', 'c')} END`,
    created: k.boolean(
      sql`${f('ordinal', 'integer')}=s.ordinal AND ${d('missing', k.dialect === 'postgres' ? 'text' : 'integer')}=${k.dialect === 'postgres' ? sql.lit('true') : raw('1')}`,
    ),
  })
  k.add(
    'result',
    sql`SELECT ${result} AS value,ce.id AS contact_event,ie.id AS identity_event,${f('ordinal', 'integer')} AS ordinal FROM ${k.entries()} JOIN ${raw(k.rows)} s ON ${k.scope()} AND s.slot='decision' AND ${d('kind')}=${f('kind')} AND ${d('value')}=${f('value')} JOIN identities i ON i.id=${d('iid', 'uuid')} LEFT JOIN contacts c ON c.id=i.contact_id AND c.organization_id=i.organization_id LEFT JOIN events ce ON ce.id=${d('ceid', 'uuid')} AND s.ordinal=${f('ordinal', 'integer')} LEFT JOIN events ie ON ie.id=${d('ieid', 'uuid')} AND s.ordinal=${f('ordinal', 'integer')} ORDER BY ${f('ordinal', 'integer')}`,
  )
}
