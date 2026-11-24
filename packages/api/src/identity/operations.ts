import { z } from 'zod'
import type { AnyResource, TenantOperation } from '../registry.js'
import { defaultBuiltIns, type BuiltIns } from '../resources/built-ins.js'
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

/**
 * The identity commands on the prepared path ([[CORE36]]): same paths, scopes, schemas and statuses. `definitions` are the custom objects of the deployment ([[CORE556]] P4): with the extended built-ins of `b`, they are the definitions whose
 * fields may reference contacts, and `contacts.merge` re-points those references.
 */
export function identityOperations(
  b: BuiltIns = defaultBuiltIns(),
  definitions: readonly AnyResource[] = [],
): TenantOperation[] {
  const { contacts } = b
  const referencing = [b.companies, b.deals, b.tasks, ...definitions]
  /** [[CORE556]] D13, 556.2: the survivor's record plus where its value won. */
  const mergeResponse = (contacts.record as unknown as z.ZodObject).extend({
    merge_conflicts: z.array(z.object({ field: z.string(), source_value: z.unknown() })).meta({
      description:
        "One entry per typed field, core or custom, where both contacts held a value and the values differ, in field order; the survivor kept its value. The source's values stay on the tombstone and in the contact.merged event. Empty when none.",
    }),
  })
  return [
    {
      kind: 'tenant',
      surface: 'api',
      name: 'identities.resolve',
      summary: 'Resolve addresses to identities, creating contacts for new ones',
      tags: ['identities'],
      method: 'post',
      path: '/identities/resolve',
      scope: { resource: 'contacts', action: 'write' },
      proposal: { eligible: true },
      validation: 'adapter',
      request: { body: resolveBody },
      response: {
        status: 200,
        schema: z.object({
          data: z.array(
            z.object({ identity: identities.record, contact: contacts.record.nullable(), created: z.boolean() }),
          ),
        }),
      },
      prepare: (env, input) => {
        const op = resolveOperation(env, (input.body as z.infer<typeof resolveBody>).identities, contacts)
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
      surface: 'api',
      name: 'contacts.merge',
      summary: 'Merge another contact into this one',
      tags: ['contacts'],
      method: 'post',
      path: '/contacts/{id}/merge',
      scope: { resource: 'contacts', action: 'write' },
      proposal: {
        eligible: true,
        target: { table: 'contacts', idArg: 'id', notFound: 'contact not found', live: true },
      },
      validation: 'adapter',
      request: { params: z.object({ id: z.uuid() }), body: z.strictObject({ source_id: z.uuid() }) },
      response: { status: 200, schema: mergeResponse },
      prepare: (env, input) =>
        mergeOperation(env, input.params.id as string, (input.body as { source_id: string }).source_id, {
          contacts,
          definitions: referencing,
        }),
    },
  ]
}
