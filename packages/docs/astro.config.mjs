import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';

export default defineConfig({
  // Override for forks; production canonical URLs always point to the documentation domain.
  site: process.env.DOCS_SITE_URL || 'https://docs.vibase.ai',
  output: 'static',
  integrations: [
    starlight({
      title: 'Vibase Docs',
      description: 'Vibase is a headless, agentic CRM. Deploy your own instance and connect through MCP, CLI, and REST.',
      logo: { src: './src/assets/logo.svg', alt: 'Vibase', replacesTitle: true },
      favicon: '/favicon.ico',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/benocodes/crm' }],
      editLink: { baseUrl: 'https://github.com/benocodes/crm/edit/main/packages/docs/' },
      customCss: ['./src/styles/custom.css'],
      plugins: [starlightOpenAPI([
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
      ])],
      sidebar: [
        { label: 'Start here', items: [
          { label: 'What is Vibase?', slug: 'getting-started/introduction' },
          { label: 'Quickstart', slug: 'getting-started/quickstart' },
        ] },
        { label: 'Concepts', items: [
          { label: 'Overview', slug: 'concepts/overview' },
          { label: 'Records and relationships', slug: 'concepts/records' },
          { label: 'Contacts and identities', slug: 'concepts/contacts-and-identities' },
          { label: 'Workspaces, users, and agents', slug: 'concepts/workspaces-and-agents' },
          { label: 'Conversations and connections', slug: 'concepts/conversations' },
          { label: 'Permissions and approvals', slug: 'concepts/permissions' },
          { label: 'Operations and discovery', slug: 'concepts/operations' },
        ] },
        { label: 'Connect your agents', items: [
          { label: 'Command line', slug: 'guides/cli' },
          { label: 'MCP and REST', slug: 'guides/mcp-and-rest' },
        ] },
        { label: 'API reference', items: [
          { label: 'About the reference', slug: 'api-reference/overview' },
          ...openAPISidebarGroups,
        ] },
        { label: 'Deploy', items: [
          { label: 'Self-host Vibase', slug: 'deployment/self-hosting' },
          { label: 'Publish these docs', slug: 'deployment/docs-site' },
        ] },
      ],
    }),
  ],
});
