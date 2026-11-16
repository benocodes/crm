import type { ClerkUserRow } from './types.js'

export async function exportClerkUsers(_o: {
  secretKey: string
  fetch: typeof fetch
  apiUrl?: string
}): Promise<ClerkUserRow[]> {
  return []
}
