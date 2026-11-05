// The label rule ([[CHN5]] D5, D70): one function over `labelIds`. A message is captured when it carries `INBOX` or `SENT` and none of the excluded labels.
const EXCLUDED = ['DRAFT', 'SPAM', 'TRASH', 'CHAT']

export function capturesLabels(labelIds: readonly string[] | undefined): boolean {
  const labels = labelIds ?? []
  if (!(labels.includes('INBOX') || labels.includes('SENT'))) return false
  return !EXCLUDED.some((l) => labels.includes(l))
}
