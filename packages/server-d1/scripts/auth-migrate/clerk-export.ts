// The Clerk side of the export ([[OPS365]] D2): every Clerk user, read with `GET /v1/users` only. Clerk pages by `limit` (at most 500) and `offset`; the response is a bare array.
// The secret goes in the Authorization header and nowhere else, and no error message carries it.
import type { ClerkUserRow } from './types.js'

const CLERK_API = 'https://api.clerk.com'
const PAGE_LIMIT = 500

interface ClerkEmail {
  id?: string
  email_address?: string
  verification?: { status?: string } | null
}
interface ClerkUserBody {
  id?: unknown
  primary_email_address_id?: string | null
  email_addresses?: ClerkEmail[]
  public_metadata?: { vibase_role?: unknown } | null
}

function normalize(u: ClerkUserBody): ClerkUserRow {
  if (typeof u?.id !== 'string' || u.id === '') throw new Error('unexpected Clerk response: a user without an id')
  // The primary address by id, as the Clerk adapter's profile read does: the first address in the list is not the primary.
  const primary = u.email_addresses?.find((e) => e.id === u.primary_email_address_id)
  const role = u.public_metadata?.vibase_role
  return {
    id: u.id,
    email: primary?.email_address ?? null,
    email_verified: primary ? primary.verification?.status === 'verified' : false,
    role: typeof role === 'string' ? role : null,
  }
}

/**
 * Reads every page, advancing the offset by what each page held and stopping at an empty one: a server that caps `limit` below what was asked still gives every user.
 * Ordered by `created_at` so offset paging is stable.
 */
export async function exportClerkUsers(o: {
  secretKey: string
  fetch: typeof fetch
  apiUrl?: string
}): Promise<ClerkUserRow[]> {
  const base = o.apiUrl ?? CLERK_API
  const users: ClerkUserRow[] = []
  for (let offset = 0; ; ) {
    const res = await o.fetch(`${base}/v1/users?limit=${PAGE_LIMIT}&offset=${offset}&order_by=created_at`, {
      method: 'GET',
      headers: { authorization: `Bearer ${o.secretKey}` },
    })
    if (!res.ok) throw new Error(`clerk users read failed: ${res.status}`)
    const page: unknown = await res.json()
    if (!Array.isArray(page)) throw new Error('unexpected Clerk response: the users list is not an array')
    if (page.length === 0) break
    for (const u of page) users.push(normalize(u as ClerkUserBody))
    offset += page.length
  }
  return users
}
