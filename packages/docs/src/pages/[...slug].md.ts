import { getCollection } from 'astro:content'
import type { APIRoute, GetStaticPaths } from 'astro'
import { isMarkdownEntry, renderMarkdown, type DocEntry } from '../lib-markdown'

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = (await getCollection('docs')).filter((e) => isMarkdownEntry(e as DocEntry))
  return entries.map((entry) => ({ params: { slug: entry.id }, props: { entry, ids: entries.map((e) => e.id) } }))
}

export const GET: APIRoute = ({ props, site }) => {
  const { entry, ids } = props as { entry: DocEntry; ids: string[] }
  const body = renderMarkdown(entry, new Set(ids), site ?? new URL('https://docs.vibase.ai'))
  return new Response(body, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
}
