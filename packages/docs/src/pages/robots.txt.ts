import type { APIRoute } from 'astro'

// Allow everything and point crawlers at the sitemap Starlight generates, on whatever host this build is for (DOCS_SITE_URL).
export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL('https://docs.vibase.ai')
  const body = `User-agent: *\nAllow: /\n\nSitemap: ${new URL('/sitemap-index.xml', origin).href}\n`
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
