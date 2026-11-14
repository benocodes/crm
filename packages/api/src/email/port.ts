// The outbound email port ([[CORE248]] D1): one message to one address. The vault ships one adapter (Cloudflare Email Service, in `@vibase/server-d1`); another sender is another adapter behind this
// interface. `send` rejects on any failure; callers decide what a failure means (an invitation is revoked, [[CORE248]] D3). Nothing here knows a provider.
export interface EmailMessage {
  to: string
  subject: string
  text: string
  html: string
}
export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}
