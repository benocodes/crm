import { sql } from 'kysely'
import type { ServiceContext } from '../context.js'
import { ApiError } from '../errors.js'
import { contacts, type ContactRecord } from '../resources/contacts.js'
import { emitResourceEvent } from '../resources/crud.js'
import { readColumns, toRecord, type ResourceDefinition } from '../resources/define.js'
import { identities } from '../resources/identities.js'

export type ContactReference = {
  def: ResourceDefinition<any>
  column: string
  /** true: only rows with deleted_at IS NULL move (soft-deletable tables). */
  liveOnly: boolean
}

/** Every FK to contacts(id) except the exemptions. [[AGT8]] appends its entries here. */
export const CONTACT_REFERENCES: readonly ContactReference[] = [{ def: identities, column: 'contact_id', liveOnly: true }]

/** FKs to contacts(id) that merge must NOT re-point: the tombstone pointer itself (D10). */
export const CONTACT_REFERENCE_EXEMPTIONS: readonly { table: string; column: string }[] = [
  { table: 'contacts', column: 'merged_into_id' },
]

type Row = Record<string, unknown>

/** Re-points every listed reference from the source to the survivor by direct write, one event per row. */
export async function repointReferences(
  ctx: ServiceContext,
  refs: readonly ContactReference[],
  sourceId: string,
  survivorId: string,
): Promise<void> {
  const trx = ctx.trx as unknown as import('kysely').Transaction<any>
  for (const ref of refs) {
    let q = trx.selectFrom(ref.def.table).select(readColumns(ref.def)).where(ref.column, '=', sourceId)
    if (ref.liveOnly) q = q.where('deleted_at', 'is', null)
    const rows = (await q.orderBy('id').forUpdate().execute()) as Row[]
    for (const row of rows) {
      const before = toRecord(ref.def, row)
      const updated = await trx
        .updateTable(ref.def.table)
        .set({ [ref.column]: survivorId })
        .where('id', '=', before.id)
        .returning(readColumns(ref.def))
        .executeTakeFirstOrThrow()
      await emitResourceEvent(ctx, ref.def, 'updated', before, toRecord(ref.def, updated as Row), before.id)
    }
  }
}

const notFound = () => new ApiError(404, 'not_found', 'contact not found')

async function lockContact(ctx: ServiceContext, id: string): Promise<ContactRecord> {
  const row = await ctx.trx
    .selectFrom('contacts')
    .select(readColumns(contacts) as never[])
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound()
  return toRecord(contacts, row as Row)
}

export async function mergeContacts(ctx: ServiceContext, survivorIdIn: string, sourceIdIn: string): Promise<ContactRecord> {
  // z.uuid() accepts upper case; compare and sort on the canonical lower-case form.
  const survivorId = survivorIdIn.toLowerCase()
  const sourceId = sourceIdIn.toLowerCase()
  // 1. Refuse self-merge.
  if (sourceId === survivorId) throw new ApiError(400, 'merge_into_self', 'a contact cannot be merged into itself')
  // 2. Lock both live rows, smaller id first.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID.test(survivorId) || !UUID.test(sourceId)) throw notFound()
  const locked = new Map<string, ContactRecord>()
  for (const id of [survivorId, sourceId].sort()) locked.set(id, await lockContact(ctx, id))
  const survivor = locked.get(survivorId)!
  const source = locked.get(sourceId)!

  // 3. Re-point references.
  await repointReferences(ctx, CONTACT_REFERENCES, sourceId, survivorId)

  // 4. Fill the survivor's empty fields; never overwrite.
  const fill: Row = {}
  for (const f of Object.keys(contacts.update!.shape)) {
    const key = f as 'name' | 'company_id'
    if (survivor[key] === null && source[key] !== null) fill[f] = source[key]
  }
  let result = survivor
  if (Object.keys(fill).length > 0) {
    const row = await ctx.trx
      .updateTable('contacts')
      .set(fill)
      .where('id', '=', survivorId)
      .returning(readColumns(contacts) as never[])
      .executeTakeFirstOrThrow()
    result = toRecord(contacts, row as Row)
    await emitResourceEvent(ctx, contacts, 'updated', survivor, result, survivorId)
  }

  // 5. Tombstone the source.
  const tomb = await ctx.trx
    .updateTable('contacts')
    .set({ deleted_at: sql`now()`, merged_into_id: survivorId })
    .where('id', '=', sourceId)
    .returning(readColumns(contacts) as never[])
    .executeTakeFirstOrThrow()
  await emitResourceEvent(ctx, contacts, 'merged', source, toRecord(contacts, tomb as Row), sourceId)

  // 6. The survivor.
  return result
}
