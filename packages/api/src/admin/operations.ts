import { z } from 'zod'
import { generateApiKey } from '../auth/api-keys.js'
import type { PreparedTenantOperation } from '../registry.js'
import { apiKeyRecord } from '../resources/api-keys.js'
import { issueApiKeyOperation, revokeApiKeyOperation } from './api-keys.js'
import { getUserOperation, listUsersOperation, listUsersQuery, userRecord } from './users.js'

const createKeyBody = z.strictObject({
  agent_id: z.uuid(),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
})

/** Hand-written administration operations: `users` has no organization_id, and key secrets must not reach reads or events. All prepared ([[CORE40]]). */
export function adminOperations(): PreparedTenantOperation[] {
  const base = { kind: 'tenant' as const, executor: 'prepared' as const }
  return [
    {
      ...base,
      name: 'users.list',
      summary: "List the organisation's members as users",
      tags: ['users'],
      method: 'get',
      path: '/users',
      scope: { resource: 'members', action: 'read' },
      validation: 'adapter',
      request: { query: listUsersQuery },
      response: { status: 200, schema: z.object({ data: z.array(userRecord), next_cursor: z.uuid().nullable() }) },
      prepare: (env, input) => listUsersOperation(env, input.query as z.infer<typeof listUsersQuery>),
    },
    {
      ...base,
      name: 'users.get',
      summary: 'Get a user',
      tags: ['users'],
      method: 'get',
      path: '/users/{id}',
      scope: { resource: 'members', action: 'read' },
      validation: 'handler',
      request: { params: z.object({ id: z.uuid() }) },
      response: { status: 200, schema: userRecord },
      prepare: (env, input) => getUserOperation(env, input.params.id as string),
    },
    {
      ...base,
      name: 'api_keys.create',
      summary: 'Issue an API key for an agent; the key is shown once',
      tags: ['api_keys'],
      method: 'post',
      path: '/api-keys',
      scope: { resource: 'agents', action: 'write' },
      validation: 'adapter',
      request: { body: createKeyBody },
      response: { status: 201, schema: apiKeyRecord.extend({ key: z.string() }) },
      // The only async prepare: the key is hashed (Web Crypto) before the unit is built, from the injected random source.
      prepare: async (env, input) => issueApiKeyOperation(env, input.body as z.infer<typeof createKeyBody>, await generateApiKey(env.randomBytes)),
    },
    {
      ...base,
      name: 'api_keys.revoke',
      summary: 'Revoke an API key',
      tags: ['api_keys'],
      method: 'post',
      path: '/api-keys/{id}/revoke',
      scope: { resource: 'agents', action: 'write' },
      validation: 'adapter',
      request: { params: z.object({ id: z.uuid() }) },
      response: { status: 200, schema: apiKeyRecord },
      prepare: (env, input) => revokeApiKeyOperation(env, input.params.id as string),
    },
  ]
}
