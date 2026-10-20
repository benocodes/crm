import { z } from 'zod'
import type { TenantOperation } from '../registry.js'
import { apiKeyRecord } from '../resources/api-keys.js'
import { issueApiKey, revokeApiKey } from './api-keys.js'
import { getUser, listUsers, listUsersQuery, userRecord } from './users.js'

const createKeyBody = z.strictObject({
  agent_id: z.uuid(),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
})

/** Hand-written administration operations: `users` has no organization_id, and key secrets must not reach reads or events. */
export function adminOperations(): TenantOperation[] {
  return [
    {
      kind: 'tenant',
      name: 'users.list',
      summary: "List the organisation's members as users",
      tags: ['users'],
      method: 'get',
      path: '/users',
      scope: { resource: 'members', action: 'read' },
      validation: 'adapter',
      request: { query: listUsersQuery },
      response: { status: 200, schema: z.object({ data: z.array(userRecord), next_cursor: z.uuid().nullable() }) },
      handler: (ctx, input) => listUsers(ctx, input.query as z.infer<typeof listUsersQuery>),
    },
    {
      kind: 'tenant',
      name: 'users.get',
      summary: 'Get a user',
      tags: ['users'],
      method: 'get',
      path: '/users/{id}',
      scope: { resource: 'members', action: 'read' },
      validation: 'handler',
      request: { params: z.object({ id: z.uuid() }) },
      response: { status: 200, schema: userRecord },
      handler: (ctx, input) => getUser(ctx, input.params.id as string),
    },
    {
      kind: 'tenant',
      name: 'api_keys.create',
      summary: 'Issue an API key for an agent; the key is shown once',
      tags: ['api_keys'],
      method: 'post',
      path: '/api-keys',
      scope: { resource: 'agents', action: 'write' },
      validation: 'adapter',
      request: { body: createKeyBody },
      response: { status: 201, schema: apiKeyRecord.extend({ key: z.string() }) },
      handler: (ctx, input) => issueApiKey(ctx, input.body as z.infer<typeof createKeyBody>),
    },
    {
      kind: 'tenant',
      name: 'api_keys.revoke',
      summary: 'Revoke an API key',
      tags: ['api_keys'],
      method: 'post',
      path: '/api-keys/{id}/revoke',
      scope: { resource: 'agents', action: 'write' },
      validation: 'adapter',
      request: { params: z.object({ id: z.uuid() }) },
      response: { status: 200, schema: apiKeyRecord },
      handler: (ctx, input) => revokeApiKey(ctx, input.params.id as string),
    },
  ]
}
