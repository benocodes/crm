// STUB (red commit): replaced by the implementation.
export interface EmailBindingLike {
  send(message: unknown): Promise<unknown>
}
export function parseEmailConfig(_env: Record<string, unknown>): { from: string } | undefined {
  return undefined
}
export function cloudflareEmailSender(_binding: EmailBindingLike, _from: string): { send(m: { to: string; subject: string; text: string; html: string }): Promise<void> } {
  return { send: async () => {} }
}
