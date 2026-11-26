import { getCollection } from 'astro:content'
import type { APIRoute } from 'astro'
import { isMarkdownEntry, renderMarkdown, type DocEntry } from '../lib-markdown'
import { sections } from '../nav.mjs'

// Every markdown page in navigation order, one after another, for an agent that wants the whole documentation in one fetch.
export const GET: APIRoute = async ({ site }) => {
  const origin = site ?? new URL('https://docs.vibase.ai')
  const entries = (await getCollection('docs')).filter((e) => isMarkdownEntry(e as DocEntry)) as unknown as DocEntry[]
  const ids = new Set(entries.map((e) => e.id))
  const byId = new Map(entries.map((e) => [e.id, e]))
  const ordered = sections.flatMap((s) => s.items.map((i) => byId.get(i.slug))).filter((e): e is DocEntry => !!e)
  const body = ordered.map((e) => renderMarkdown(e, ids, origin)).join('\n\n---\n\n')
  return new Response(`${body}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
