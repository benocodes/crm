// The Gmail REST shapes the vault reads ([[CHN5]] D24, D35): `users.messages.get` with `format=full`. Only the fields the mapper uses.
export interface GmailHeader {
  name: string
  value: string
}

export interface GmailMessagePartBody {
  /** The declared size in bytes of the decoded body. */
  size?: number
  /** base64url; present for body parts, absent for attachments. */
  data?: string
  attachmentId?: string
}

export interface GmailMessagePart {
  partId?: string
  mimeType?: string
  /** Empty for a body part. */
  filename?: string
  headers?: GmailHeader[]
  body?: GmailMessagePartBody
  parts?: GmailMessagePart[]
}

/** `users.getProfile`: the mailbox address and the history id a sync starts from. */
export interface GmailProfile {
  emailAddress: string
  historyId: string
  messagesTotal?: number
  threadsTotal?: number
}
/** One entry of `users.settings.sendAs.list`. The primary address has `isPrimary` and no `verificationStatus`; an alias is usable once `verificationStatus` is `accepted`. */
export interface GmailSendAs {
  sendAsEmail: string
  isPrimary?: boolean
  verificationStatus?: string
  displayName?: string
  treatAsAlias?: boolean
}

/** `users.watch`'s answer ([[CHN5]] D89): both are strings; `expiration` is epoch milliseconds. */
export interface GmailWatch {
  historyId: string
  expiration: string
}

export interface GmailMessageResource {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  historyId?: string
  /** Epoch milliseconds, as a string. */
  internalDate?: string
  sizeEstimate?: number
  payload?: GmailMessagePart
}

/** One history record, reduced to what capture reads ([[CHN5]] D6): only `messagesAdded`. Labels, deletions and the record's other message lists are dropped at the parser. */
export interface GmailHistoryRecord {
  id: string
  messagesAdded: Array<{ message: { id: string; threadId?: string; labelIds?: string[] } }>
}
/** A `users.history.list` page. Gmail omits `history` on an empty page and `nextPageToken` on the last; the parser makes those `[]` and `null`. */
export interface GmailHistoryPage {
  history: GmailHistoryRecord[]
  nextPageToken: string | null
  /** The mailbox's current history id, as of this response. */
  historyId: string | null
}
/** A `users.messages.list` page (ids only). Gmail omits `messages` when nothing matches and `nextPageToken` on the last page. */
export interface GmailMessageList {
  messages: Array<{ id: string; threadId?: string }>
  nextPageToken: string | null
}
