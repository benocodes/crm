import { z } from 'zod'
import type { TenantOperation } from '../registry.js'
import { contacts } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { mergeOperation } from './merge.js'
import { resolveOperation } from './resolve.js'

const resolveBody = z.strictObject({
  identities: z
    .array(
      z.strictObject({
        kind: z.enum(['email', 'phone']),
        value: z.string().min(1).max(320),
        name: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .min(1)
    .max(100),
})

/** The identity commands on the prepared path ([[CORE36]]): same paths, scopes, schemas and statuses. */
export function identityOperations(): TenantOperation[] {
  return [
    {
      kind: 'tenant',
      name: 'identities.resolve',
      summary: 'Resolve addresses to identities, creating contacts for new ones',
      tags: ['identities'],
      method: 'post',
      path: '/identities/resolve',
      scope: { resource: 'contacts', action: 'write' },
      validation: 'adapter',
      request: { body: resolveBody },
      response: {
        status: 200,
        schema: z.object({
          data: z.array(z.object({ identity: identities.record, contact: contacts.record.nullable(), created: z.boolean() })),
        }),
      },
      prepare: (env, input) => {
        const op = resolveOperation(env, (input.body as z.infer<typeof resolveBody>).identities)
        // The response wraps the results as { data }; the unit is built once.
        return {
          ...op,
          build: (found, qc) => {
            const built = op.build(found, qc)
            return { ...built, decode: (rows, f) => ({ data: built.decode(rows, f) }) }
          },
        }
      },
    },
    {
      kind: 'tenant',
      name: 'contacts.merge',
      summary: 'Merge another contact into this one',
      tags: ['contacts'],
      method: 'post',
      path: '/contacts/{id}/merge',
      scope: { resource: 'contacts', action: 'write' },
      validation: 'adapter',
      request: { params: z.object({ id: z.uuid() }), body: z.strictObject({ source_id: z.uuid() }) },
      response: { status: 200, schema: contacts.record },
      prepare: (env, input) => mergeOperation(env, input.params.id as string, (input.body as { source_id: string }).source_id),
    },
  ]
}
