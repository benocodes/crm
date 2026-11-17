// The label rule ([[CHN5]] D5, D70; [[CHN407]] D2): one function over `labelIds` and a connection's `capture_labels`. A message is captured when it carries at
// least one of the listed labels and none of the excluded ones. With the default list (`INBOX`, `SENT`) it is exactly the rule before CHN407.
const EXCLUDED = ['DRAFT', 'SPAM', 'TRASH', 'CHAT']

export function capturesLabels(labelIds: readonly string[] | undefined, captureLabels: readonly string[]): boolean {
  const labels = labelIds ?? []
  if (!captureLabels.some((l) => labels.includes(l))) return false
  return !EXCLUDED.some((l) => labels.includes(l))
}

/** The scan query's label clause ([[CHN407]] D3, P2): braces kept for one label; empty when any listed label is outside `INBOX`/`SENT` (the rule on each message decides). */
export function scanLabelClause(captureLabels: readonly string[]): string {
  if (captureLabels.length === 0 || !captureLabels.every((l) => l === 'INBOX' || l === 'SENT')) return ''
  const terms = [
    captureLabels.includes('INBOX') ? 'in:inbox' : '',
    captureLabels.includes('SENT') ? 'in:sent' : '',
  ].filter(Boolean)
  return `{${terms.join(' ')}}`
}
