import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import { sections } from './src/nav.mjs'
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi'

const site = process.env.DOCS_SITE_URL || 'https://docs.vibase.ai'
const ogImage = new URL('/og.png', site).href

export default defineConfig({
  // Override for forks; production canonical URLs always point to the documentation domain.
  site,
  output: 'static',
  integrations: [
    starlight({
      title: 'Vibase Docs',
      description:
        'Vibase is a headless, agentic CRM. Deploy your own instance and connect through MCP, CLI, and REST.',
      logo: { src: './src/assets/logo.svg', alt: 'Vibase', replacesTitle: true },
      favicon: '/favicon.ico',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/benocodes/crm' }],
      editLink: { baseUrl: 'https://github.com/benocodes/crm/edit/main/packages/docs/' },
      routeMiddleware: './src/route-data.ts',
      components: { PageTitle: './src/components/PageTitle.astro' },
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: ogImage } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'Vibase' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: ogImage } },
      ],
      customCss: ['./src/styles/custom.css'],
      plugins: [
        starlightOpenAPI([
          {
            base: 'api-reference/records',
            schema: './public/openapi/api.json',
            sidebar: { label: 'Records API', operations: { labels: 'operationId', badges: true } },
          },
          {
            base: 'api-reference/workspace',
            schema: './public/openapi/meta.json',
            sidebar: { label: 'Workspace API', operations: { labels: 'operationId', badges: true } },
          },
        ]),
      ],
      sidebar: sections.map((section) =>
        section.api ? { label: section.label, items: [...section.items, ...openAPISidebarGroups] } : section,
      ),
    }),
  ],
})
