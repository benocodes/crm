// The docs navigation, shared by the Starlight sidebar (astro.config.mjs) and the llms.txt table of contents.
// A section with `api: true` is the generated API reference: the sidebar fills it from the OpenAPI documents.
export const sections = [
  {
    label: 'Start here',
    items: [
      { label: 'What is Vibase?', slug: 'getting-started/introduction' },
      { label: 'Quickstart', slug: 'getting-started/quickstart' },
    ],
  },
  {
    label: 'Concepts',
    items: [
      { label: 'Overview', slug: 'concepts/overview' },
      { label: 'Records and relationships', slug: 'concepts/records' },
      { label: 'Contacts and identities', slug: 'concepts/contacts-and-identities' },
      { label: 'Workspaces, users, and agents', slug: 'concepts/workspaces-and-agents' },
      { label: 'Conversations and connections', slug: 'concepts/conversations' },
      { label: 'Permissions and approvals', slug: 'concepts/permissions' },
      { label: 'Operations and discovery', slug: 'concepts/operations' },
    ],
  },
  {
    label: 'Connect your agents',
    items: [
      { label: 'Invite agents and manage permissions', slug: 'guides/agents' },
      { label: 'Command line', slug: 'guides/cli' },
      { label: 'MCP and REST', slug: 'guides/mcp-and-rest' },
    ],
  },
  {
    label: 'Build apps and workflows',
    items: [
      { label: 'Build apps on your instance', slug: 'guides/build-apps' },
      { label: 'TypeScript SDK', slug: 'guides/sdk' },
      { label: 'OAuth clients for your apps', slug: 'guides/oauth-clients' },
      { label: 'Webhooks', slug: 'guides/webhooks' },
      { label: 'Website forms', slug: 'guides/forms' },
    ],
  },
  {
    label: 'Customize your data',
    items: [{ label: 'Custom objects and fields', slug: 'guides/schema' }],
  },
  { label: 'API reference', api: true, items: [{ label: 'About the reference', slug: 'api-reference/overview' }] },
  {
    label: 'Deploy',
    items: [
      { label: 'Self-host Vibase', slug: 'deployment/self-hosting' },
      { label: 'Publish these docs', slug: 'deployment/docs-site' },
    ],
  },
]
