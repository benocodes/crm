// A leaf with no imports, so a browser bundle can embed the catalogue at build time without pulling `@vibase/api`'s index ([[UI449]] D2; `@vibase/api/scope-areas`,
// beside `scope-descriptions`). `roles.ts` re-exports `NOT_DEFAULT_GRANT`. A catalogue test holds every declared scope's resource in exactly one area.

/** Scopes grantable to an agent but never part of a default grant ([[CORE261]] P2). */
export const NOT_DEFAULT_GRANT: readonly string[] = ['audit:read']

export type ScopeArea = {
  key: string
  name: string
  /** One sentence for the consent page; text only. */
  sentence: string
  /** The resources whose scopes belong to this area. */
  resources: readonly string[]
}

/** The consent areas ([[UI449]] D1), keyed by resource so every action of one resource sits in one area. */
export const SCOPE_AREAS: readonly ScopeArea[] = [
  {
    key: 'crm',
    name: 'CRM records',
    sentence: 'Your contacts, companies, deals, pipelines, tasks, notes and tags, and the links between them.',
    resources: ['contacts', 'companies', 'deals', 'pipelines', 'tasks', 'notes', 'tags', 'associations'],
  },
  {
    key: 'messages',
    name: 'Messages',
    sentence: 'Your emails, calendar events and chats, their attachments, and the mailboxes and forms behind them.',
    resources: ['interactions', 'messages', 'files', 'connections', 'blocked_senders', 'forms'],
  },
  {
    key: 'activity',
    name: 'Activity and approvals',
    sentence: 'The log of what happened in the workspace and the queue of changes waiting for review.',
    resources: ['events', 'action_requests'],
  },
  {
    key: 'integrations',
    name: 'Integrations',
    sentence: 'Webhooks that notify other systems, and the description of the workspace’s data.',
    resources: ['webhooks', 'schema'],
  },
  {
    key: 'admin',
    name: 'Administration',
    sentence: 'Who is in the workspace, which agents act for it, invitations, and the audit log.',
    resources: ['members', 'agents', 'invitations', 'audit'],
  },
]

/** The key of the area a scope belongs to, by its resource; `null` for a name in no area or one that is not `resource:action`. */
export function areaOfScope(scope: string): string | null {
  const resource = /^([a-z][a-z0-9_]*):(?:read|request_approval|write)$/.exec(scope)?.[1]
  if (resource === undefined) return null
  return SCOPE_AREAS.find((a) => a.resources.includes(resource))?.key ?? null
}
