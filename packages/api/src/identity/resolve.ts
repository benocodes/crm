import type { ServiceContext } from '../context.js'
import { ApiError } from '../errors.js'
import { contacts, type ContactRecord } from '../resources/contacts.js'
import { createResource, emitResourceEvent } from '../resources/crud.js'
import { toRecord } from '../resources/define.js'
import { identities, insertIdentity, type IdentityRecord } from '../resources/identities.js'
import { addressKey, lockKeys } from './locks.js'
import { normalizeIdentityValue, type IdentityKind } from './normalize.js'

export type ResolveEntry = { kind: IdentityKind; value: string; name?: string }
export type ResolveResult = { identity: IdentityRecord; contact: ContactRecord | null; created: boolean }

const identityColumns = Object.keys(identities.record.shape)
const contactColumns = Object.keys(contacts.record.shape)

async function liveIdentity(ctx: ServiceContext, kind: IdentityKind, value: string): Promise<IdentityRecord | undefined> {
  const row = await ctx.trx
    .selectFrom('identities')
    .select(identityColumns as never[])
    .where('kind', '=', kind)
    .where('value', '=', value)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return row ? toRecord(identities, row as Record<string, unknown>) : undefined
}

/** Display names arrive from channels: trim, treat blank as absent, cap at the contact name limit. */
export function cleanName(name: string | undefined): string | undefined {
  const t = name?.trim().slice(0, 500).trim()
  return t ? t : undefined
}

/** [[CHN5]] calls this inside its own context. No batch limit here; [] gives []. */
export async function resolveIdentities(ctx: ServiceContext, entries: readonly ResolveEntry[]): Promise<ResolveResult[]> {
  // 1. Normalise every entry before any lock or write.
  const normalized = entries.map((e, i) => {
    try {
      return { ...e, value: normalizeIdentityValue(e.kind, e.value) }
    } catch (err) {
      if (err instanceof ApiError) throw new ApiError(err.status, err.code, `identities[${i}]: ${err.message}`)
      throw err
    }
  })
  if (normalized.length === 0) return []

  // 2. Lock every distinct address in one statement, in hash order.
  await lockKeys(ctx.trx, normalized.map((e) => addressKey(ctx.organizationId, e.kind, e.value)))

  // 3. Known identities, then the live contacts they point at.
  const known = new Map<string, IdentityRecord>()
  for (const kind of ['email', 'phone'] as const) {
    const values = [...new Set(normalized.filter((e) => e.kind === kind).map((e) => e.value))]
    if (values.length === 0) continue
    const rows = await ctx.trx
      .selectFrom('identities')
      .select(identityColumns as never[])
      .where('kind', '=', kind)
      .where('value', 'in', values)
      .where('deleted_at', 'is', null)
      .execute()
    for (const r of rows) {
      const rec = toRecord(identities, r as Record<string, unknown>)
      known.set(`${rec.kind}:${rec.value}`, rec)
    }
  }
  const contactIds = [...new Set([...known.values()].map((i) => i.contact_id).filter((id): id is string => id !== null))]
  const contactById = new Map<string, ContactRecord>()
  if (contactIds.length > 0) {
    const rows = await ctx.trx
      .selectFrom('contacts')
      .select(contactColumns as never[])
      .where('id', 'in', contactIds)
      .where('deleted_at', 'is', null)
      .execute()
    for (const r of rows) {
      const rec = toRecord(contacts, r as Record<string, unknown>)
      contactById.set(rec.id, rec)
    }
  }
  const contactOf = async (identity: IdentityRecord): Promise<ContactRecord | null> => {
    if (identity.contact_id === null) return null
    const cached = contactById.get(identity.contact_id)
    if (cached) return cached
    const row = await ctx.trx
      .selectFrom('contacts')
      .select(contactColumns as never[])
      .where('id', '=', identity.contact_id)
      .executeTakeFirstOrThrow()
    return toRecord(contacts, row as Record<string, unknown>)
  }

  // 4. Walk in input order.
  const results: ResolveResult[] = []
  for (const e of normalized) {
    const key = `${e.kind}:${e.value}`
    const hit = known.get(key)
    if (hit) {
      results.push({ identity: hit, contact: await contactOf(hit), created: false })
      continue
    }
    const contact = await createResource(ctx, contacts, cleanName(e.name) ? { name: cleanName(e.name) } : {})
    const inserted = await insertIdentity(ctx, { kind: e.kind, value: e.value, contact_id: contact.id, own: false })
    if (inserted) {
      await emitResourceEvent(ctx, identities, 'created', null, inserted, inserted.id)
      known.set(key, inserted)
      contactById.set(contact.id, contact)
      results.push({ identity: inserted, contact, created: true })
      continue
    }
    // 5. Backstop: cannot happen while every insert path takes the lock; costs one orphan contact.
    const existing = await liveIdentity(ctx, e.kind, e.value)
    if (!existing) throw new Error('identity vanished during resolve')
    known.set(key, existing)
    results.push({ identity: existing, contact: await contactOf(existing), created: false })
  }
  return results
}

/** [[CHN5]] D10: makes an address one of the organisation's own. Not an operation. */
export async function ensureOwnIdentity(
  ctx: ServiceContext,
  address: { kind: IdentityKind; value: string },
): Promise<{ identity: IdentityRecord; outcome: 'created' | 'moved' | 'unchanged' }> {
  const value = normalizeIdentityValue(address.kind, address.value)
  await lockKeys(ctx.trx, [addressKey(ctx.organizationId, address.kind, value)])
  const existing = await liveIdentity(ctx, address.kind, value)
  if (!existing) {
    const inserted = await insertIdentity(ctx, { kind: address.kind, value, contact_id: null, own: true })
    if (!inserted) throw new Error('identity insert conflicted under lock')
    await emitResourceEvent(ctx, identities, 'created', null, inserted, inserted.id)
    return { identity: inserted, outcome: 'created' }
  }
  if (existing.own) return { identity: existing, outcome: 'unchanged' }
  const row = await ctx.trx
    .updateTable('identities')
    .set({ contact_id: null, own: true })
    .where('id', '=', existing.id)
    .returning(identityColumns as never[])
    .executeTakeFirstOrThrow()
  const after = toRecord(identities, row as Record<string, unknown>)
  await emitResourceEvent(ctx, identities, 'updated', existing, after, existing.id)
  return { identity: after, outcome: 'moved' }
}

// ---- CORE36 stubs (replaced in Phase 3) ----
export function resolveOperation(_env: unknown, _entries: readonly ResolveEntry[]): never {
  throw new Error('not implemented')
}
