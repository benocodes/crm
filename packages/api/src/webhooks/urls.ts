// [[API7]] D13: the target URL rules. STUB (red commit): accepts everything; the rules follow in the implementation commit.
export type UrlVerdict = { ok: true } | { ok: false; reason: string }

export function validateWebhookUrl(_raw: string, _options: { allowInsecure: boolean }): UrlVerdict {
  return { ok: true }
}
