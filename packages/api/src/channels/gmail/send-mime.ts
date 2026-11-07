export interface OutboundPost {
  from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; client_ref: string
  provider_thread_id: string | null; provider_anchor_id: string | null; in_reply_to?: string; references?: string[]
}
export function outboundMime(_p:OutboundPost):string{return ''}
