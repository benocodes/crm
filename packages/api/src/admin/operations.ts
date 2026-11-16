import { z } from 'zod'
import type { TenantOperation } from '../registry.js'
import { getUserOperation, listUsersOperation, listUsersQuery, userRecord } from './users.js'

/** Hand-written administration operations: `users` has no organization_id. All prepared ([[CORE40]]); the key operations are control operations (`api-keys.ts`, [[CORE351]]). */
export function adminOperations(): TenantOperation[] {
  const base = { kind: 'tenant' as const, surface: 'meta' as const }
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
  ]
}
