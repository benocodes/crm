import { getCollection } from 'astro:content'
import type { APIRoute } from 'astro'
import { sections } from '../nav.mjs'

// The agent table of contents: every page in sidebar order, linked to its markdown twin, with its description.
// Follows https://llmstxt.org: an H1, a blockquote, then H2 lists of links to the markdown pages, each with a note.
export const GET: APIRoute = async ({ site }) => {
  const origin = site ?? new URL('https://docs.vibase.ai')
  const pages = new Map((await getCollection('docs')).map((e) => [e.id, e.data]))
  const link = (path: string) => new URL(path, origin).href

  const lines = [
    '# Vibase Docs',
    '',
    '> Vibase is a headless, agentic CRM. Deploy your own instance and connect through MCP, CLI, and REST.',
    '',
    'Every page is also served as markdown: add `.md` to its path (for example `/getting-started/quickstart.md`).',
  ]
  for (const section of sections) {
    lines.push('', `## ${section.label}`, '')
    for (const item of section.items) {
      const data = pages.get(item.slug)
      lines.push(`- [${item.label}](${link(`/${item.slug}.md`)})${data?.description ? `: ${data.description}` : ''}`)
    }
    if (section.api) {
      lines.push(
        `- [Records API, OpenAPI JSON](${link('/openapi/api.json')}): every operation on the records API (\`/api/v1\`)`,
        `- [Workspace API, OpenAPI JSON](${link('/openapi/meta.json')}): every operation on the workspace API (\`/meta/v1\`)`,
        '- Your own instance also serves both documents, with its custom objects and fields, and `GET /.well-known/vibase` lists its URLs.',
      )
    }
  }
  lines.push(
    '',
    '## Optional',
    '',
    `- [Full documentation](${link('/llms-full.txt')}): every page above concatenated in this order, for one fetch`,
    '',
  )
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
