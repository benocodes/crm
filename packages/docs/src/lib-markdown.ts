// Shared by the `.md` endpoint: turn a docs entry into the markdown an agent reads.
export type DocEntry = { id: string; filePath?: string; body?: string; data: { title: string; description?: string } }

/** Only plain markdown pages get a `.md` twin; `.mdx` pages (the splash home) hold components. */
export const isMarkdownEntry = (e: DocEntry): boolean => (e.filePath ?? '').endsWith('.md')

export const mdPath = (id: string): string => `/${id}.md`

/** Rewrites site-absolute links to other twin pages (`/guides/cli/#x`) to their `.md` form, and makes them absolute. */
export function renderMarkdown(entry: DocEntry, ids: ReadonlySet<string>, site: URL): string {
  const body = (entry.body ?? '').replace(
    /\]\((\/[^)\s#]*?)\/?(#[^)\s]*)?\)/g,
    (whole, path: string, hash?: string) => {
      const id = path.replace(/^\//, '')
      return ids.has(id) ? `](${new URL(mdPath(id), site).href}${hash ?? ''})` : whole
    },
  )
  const html = new URL(`/${entry.id}/`, site).href
  const description = entry.data.description ? `\n> ${entry.data.description}\n` : ''
  return `# ${entry.data.title}\n${description}\nHTML version: ${html}\nDocs index for agents: ${new URL('/llms.txt', site).href}\n\n---\n\n${body.trim()}\n`
}
