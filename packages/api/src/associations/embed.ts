import { sql } from 'kysely'
import { z } from 'zod'
import { codecs, defineOperation, readAll, readMaybe, unit, type PreparedOperation } from '@vault/storage'
import { ApiError } from '../errors.js'
import { formatScope } from '../scopes.js'
import { canonicalId } from '../storage/prepare.js'
import { selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv, PreparedResource } from '../storage/definition.js'
import { listItem, orientedEdges, readableTypes, type AssociationListItem } from './operations.js'
import type { EndpointTypes } from './definition.js'

// `include=associations` on `get` ([[CORE62]] D6, decided in [[CORE74]]): the record plus its newest live edges in the same read unit.

/** The values `include` accepts; anything else is `400 validation_error` from the query schema. */
export const includeQuery = z.enum(['associations'])
/** The embedded list is capped here; `associations.list` pages all of them. */
export const EMBEDDED_LIMIT = 50
const ASSOCIATIONS_READ = { resource: 'associations', action: 'read' } as const

/** The fields `include=associations` adds to an associable record's response. */
export const embeddedFields = {
  associations: z.array(listItem).optional(),
  associations_truncated: z.boolean().optional(),
}

/**
 * `<resource>.get` with the record's edges: the 50 newest live edges by association id (descending), restricted in SQL to
 * neighbour types the caller can read, so the cap counts only visible edges. Needs `associations:read` on top of the record's own scope.
 */
export function getWithAssociations<R extends { id: string }>(
  def: PreparedResource<PreparedResource['table'], R>,
  env: PreparedEnv,
  types: EndpointTypes,
  rawId: string,
): PreparedOperation<R & { associations: AssociationListItem[]; associations_truncated: boolean }> {
  if (!env.scopes.has(ASSOCIATIONS_READ)) {
    throw new ApiError(403, 'insufficient_scope', `requires ${formatScope(ASSOCIATIONS_READ)} to include associations`)
  }
  const id = canonicalId(def, rawId)
  const readable = readableTypes(env, types)
  return defineOperation({
    name: `${def.name}.get`,
    mutates: false,
    reads: (qc) => ({
      row: readMaybe(selectRecord(def, qc, env, id)),
      edges: readAll(orientedEdges(qc, env, { type: def.table, id }, readable).orderBy(sql.ref('associations.id'), 'desc').limit(EMBEDDED_LIMIT + 1)),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const row = found.maybe('row')
          if (!row) throw new ApiError(404, 'not_found', `${def.eventName} not found`)
          const rows = found.all('edges')
          return {
            ...toRecord(def, row),
            associations: rows.slice(0, EMBEDDED_LIMIT).map((r) => listItem.parse({ ...r, created_at: codecs.timestamp.readNullable(r.created_at) ?? r.created_at })),
            associations_truncated: rows.length > EMBEDDED_LIMIT,
          }
        },
      }),
  })
}
