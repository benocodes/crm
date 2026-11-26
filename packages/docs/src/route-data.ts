import { defineRouteMiddleware } from '@astrojs/starlight/route-data'

// llms.txt spec: point each HTML page at its markdown twin (rel="alternate") and at the llms.txt that describes it (rel="describedby").
export const onRequest = defineRouteMiddleware((context) => {
  const { entry, head } = context.locals.starlightRoute
  if (!(entry as { filePath?: string }).filePath?.endsWith('.md')) return
  head.push(
    { tag: 'link', attrs: { rel: 'alternate', type: 'text/markdown', href: `/${entry.id}.md` } },
    { tag: 'link', attrs: { rel: 'describedby', href: '/llms.txt' } },
  )
})
