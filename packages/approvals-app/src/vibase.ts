// The vault REST calls the page makes, through `@vibase/sdk` ([[DX603]] D13). A fresh session token per request, sent only as `Authorization: Bearer`.
import { createClient, VibaseError } from '@vibase/sdk'
import type { ActionRequest } from './format.js'

export interface Api {
  list(status: string): Promise<ActionRequest[]>
  /** One request; for messages.send this carries the body text, which the list does not. */
  get(id: string): Promise<ActionRequest>
  approve(id: string, reason?: string): Promise<ActionRequest>
  reject(id: string, reason?: string): Promise<ActionRequest>
}

/** The list reads pages of this many requests and stops after this many items (20 full pages, as the page always did). */
const PAGE_SIZE = 100
const MAX_ITEMS = 2000

export function createApi(
  apiOrigin: string,
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = (i, init) => fetch(i, init),
): Api {
  const vibase = createClient({ url: apiOrigin, auth: getToken, fetch: fetchImpl })
  const decide = (verb: 'approve' | 'reject') => (id: string, reason?: string) =>
    vibase.actionRequests[verb]({ id, ...(reason ? { decision_reason: reason } : {}) })
  return {
    async list(status) {
      const all: ActionRequest[] = []
      for await (const item of vibase.actionRequests.list.all({ status, limit: PAGE_SIZE })) {
        all.push(item)
        if (all.length >= MAX_ITEMS) break
      }
      return all
    },
    get: (id) => vibase.actionRequests.get({ id }),
    approve: decide('approve'),
    reject: decide('reject'),
  }
}

/** The words the page shows for a failed call ([[DX609]] P2): the same as before the SDK, whatever the SDK's own message says. */
export function failureText(e: unknown): string {
  if (!(e instanceof VibaseError)) return 'Vibase could not be reached.'
  switch (e.code) {
    case 'no_credential':
      return 'Your session has ended. Sign in again.'
    case 'network_error':
      return 'Vibase could not be reached.'
    case 'invalid_response':
      return 'Vibase sent an answer this page could not read.'
    case 'unexpected_redirect':
      return 'Vibase answered with a redirect, which this page does not follow.'
    case 'origin_mismatch':
      return 'This page is set up for a different Vibase address.'
  }
  if (e.code === `http_${e.status}`) return `Request failed (${e.status})`
  if (e.status === 403)
    return `Not allowed: ${e.message}. This account needs the action_requests read scope (and the target's write scope to approve).`
  return e.message
}
