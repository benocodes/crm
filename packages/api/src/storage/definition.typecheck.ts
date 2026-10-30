// Type fixtures at the definePreparedResource call site ([[CORE35]] D3, review F1). Not a Vitest file; `pnpm
// typecheck` includes it. Every `@ts-expect-error` sits on the exact offending expression, each has a positive
// sibling, and nothing is cast around the call.
import { z } from 'zod'
import { membershipRecord } from '../account/organizations.js'
import { agentRecord, agents } from '../resources/agents.js'
import { apiKeyRecord, apiKeys } from '../resources/api-keys.js'
import { memberships } from '../resources/memberships.js'
import { definePreparedResource } from './definition.js'

const filter = { schema: z.string() }
const tasksRecord = z.object({ id: z.uuid(), title: z.string(), status: z.enum(['open', 'done']), completed_at: z.string().nullable() })

// --- positive siblings -------------------------------------------------------------------------------

export const ok = definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  filters: { status: filter },
  references: { assignee_id: { table: 'principals' } },
  computed: ({ eb }) => ({ completed_at: eb.case().when('tasks.status', '=', 'done').then(eb.ref('tasks.completed_at')).else('2026-10-22T09:00:00.000Z').end(), title: 'x' }),
  guards: (eb) => [eb('tasks.title', '=', 'x')],
})
// A record may be a subset of the columns, and the inferred record type flows out.
export const title: string = ok.record.parse({}).title

// --- negative cases ----------------------------------------------------------------------------------

// unknown record column
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  // @ts-expect-error 'bogus' is not a column of tasks
  record: z.object({ id: z.uuid(), bogus: z.string() }),
})

// secret record column
definePreparedResource({
  name: 'api_keys',
  eventName: 'api_key',
  table: 'api_keys',
  // @ts-expect-error key_hash is a secret column
  record: z.object({ id: z.uuid(), key_hash: z.string() }),
})
export const okKeys = definePreparedResource({ name: 'api_keys', eventName: 'api_key', table: 'api_keys', record: z.object({ id: z.uuid(), prefix: z.string() }) })

// record value incompatible with the column
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  // @ts-expect-error title is text, the record says number
  record: z.object({ id: z.uuid(), title: z.number() }),
})

// unknown computed column
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  // @ts-expect-error 'bogus' is not a column of tasks
  computed: () => ({ bogus: 'x' }),
})

// wrong computed value type
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  // @ts-expect-error completed_at is a timestamp text or null, not a number
  computed: () => ({ completed_at: 5 }),
})

// unknown filter column
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  // @ts-expect-error 'bogus' is not a column of tasks
  filters: { bogus: filter },
})

// unknown reference column
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  // @ts-expect-error 'bogus' is not a column of tasks
  references: { bogus: { table: 'principals' } },
})

// guard on another table
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  // @ts-expect-error companies is not in scope of a tasks guard
  guards: (eb) => [eb('companies.name', '=', 'x')],
})

// --- CORE36: the identity-model tables ---------------------------------------------------------------

const companiesRecord = z.object({ id: z.uuid(), name: z.string(), domain: z.string().nullable() })
const contactsRecord = z.object({ id: z.uuid(), name: z.string().nullable(), company_id: z.uuid().nullable() })
const identitiesRecord = z.object({ id: z.uuid(), kind: z.enum(['email', 'phone']), value: z.string(), contact_id: z.uuid().nullable(), own: z.boolean() })

// positive siblings: the new tables, a live reference, an owner-rule-shaped prepare hook
export const okCompanies = definePreparedResource({ name: 'companies', eventName: 'company', table: 'companies', record: companiesRecord })
export const okContacts = definePreparedResource({
  name: 'contacts',
  eventName: 'contact',
  table: 'contacts',
  record: contactsRecord,
  references: { company_id: { table: 'companies', live: true } },
})
export const okIdentities = definePreparedResource({
  name: 'identities',
  eventName: 'identity',
  table: 'identities',
  record: identitiesRecord,
  references: { contact_id: { table: 'contacts', live: true } },
  prepare: ({ values }) => ({ contact_id: (values.contact_id as string | undefined) ?? null, own: values.own === true }),
})

// 1. unknown record column on companies
definePreparedResource({
  name: 'companies',
  eventName: 'company',
  table: 'companies',
  // @ts-expect-error 'industry' is not a column of companies
  record: z.object({ id: z.uuid(), industry: z.string() }),
})

// 2. mistyped record column on contacts
definePreparedResource({
  name: 'contacts',
  eventName: 'contact',
  table: 'contacts',
  // @ts-expect-error name is text or null, the record says number
  record: z.object({ id: z.uuid(), name: z.number().nullable() }),
})

// 3. mistyped boolean on identities
definePreparedResource({
  name: 'identities',
  eventName: 'identity',
  table: 'identities',
  // @ts-expect-error own is a boolean, the record says string
  record: z.object({ id: z.uuid(), own: z.string() }),
})

// 4. a reference to a table that is not a portable table
definePreparedResource({
  name: 'contacts',
  eventName: 'contact',
  table: 'contacts',
  record: contactsRecord,
  // @ts-expect-error 'deals' is not a table a reference can name
  references: { company_id: { table: 'deals' } },
})

// 5. a reference column that is not a column of the table
definePreparedResource({
  name: 'contacts',
  eventName: 'contact',
  table: 'contacts',
  record: contactsRecord,
  // @ts-expect-error 'bogus' is not a column of contacts
  references: { bogus: { table: 'companies' } },
})

// 6. an async hook on companies
definePreparedResource({
  name: 'companies',
  eventName: 'company',
  table: 'companies',
  record: companiesRecord,
  // @ts-expect-error a prepare hook must be synchronous
  prepare: async () => ({}),
})

// --- CORE40: the administration tables ---------------------------------------------------------------

// positive siblings: the real definitions compile, and so do call-site copies of them
export const realAdministration = [agents, memberships, apiKeys]
export const okAgents = definePreparedResource({ name: 'agents', eventName: 'agent', table: 'agents', record: agentRecord, filters: {} })
export const okMemberships = definePreparedResource({ name: 'memberships', eventName: 'membership', table: 'memberships', record: membershipRecord, filters: { role: filter } })
export const okApiKeys = definePreparedResource({ name: 'api_keys', eventName: 'api_key', table: 'api_keys', record: apiKeyRecord, filters: { agent_id: filter } })

// 1. an api_keys record that carries the secret column
definePreparedResource({
  name: 'api_keys',
  eventName: 'api_key',
  table: 'api_keys',
  // @ts-expect-error key_hash is a secret column of api_keys
  record: apiKeyRecord.extend({ key_hash: z.string() }),
})

// 2. an agents record that mistypes the array column
definePreparedResource({
  name: 'agents',
  eventName: 'agent',
  table: 'agents',
  // @ts-expect-error scopes is a string array, the record says string
  record: agentRecord.extend({ scopes: z.string() }),
})

// 3. a memberships record with a field that is not a column
definePreparedResource({
  name: 'memberships',
  eventName: 'membership',
  table: 'memberships',
  // @ts-expect-error email is a column of users, not of memberships
  record: membershipRecord.extend({ email: z.string() }),
})

// 4. an async hook on agents
definePreparedResource({
  name: 'agents',
  eventName: 'agent',
  table: 'agents',
  record: agentRecord,
  // @ts-expect-error a prepare hook must be synchronous
  prepare: async () => ({}),
})

// 5. an unknown filter column on api_keys
definePreparedResource({
  name: 'api_keys',
  eventName: 'api_key',
  table: 'api_keys',
  record: apiKeyRecord,
  // @ts-expect-error 'bogus' is not a column of api_keys
  filters: { bogus: filter },
})

// --- CORE25: embeds, join filters, the files reference, hidden columns ---------------------------------

import { sql } from 'kysely'

const attachmentRecord = z.array(z.object({ id: z.uuid(), position: z.number(), size_bytes: z.number().nullable() }))
const messagesBase = { id: z.uuid(), thread_id: z.uuid(), kind: z.enum(['message', 'reaction']), occurred_at: z.string() }
const interactionsBase = { id: z.uuid(), kind: z.enum(['message', 'reaction']), thread_id: z.uuid().nullable() }
const goodEmbed = { attachments: { table: 'message_attachments', key: 'message_id', columns: ['id', 'position', 'size_bytes'], orderBy: ['position'] } } as const

// positive siblings: an embed whose record field is an array, a join filter, a files reference, a hidden column typed right
export const okMessages = definePreparedResource({
  name: 'messages',
  eventName: 'message',
  table: 'messages',
  record: z.object({ ...messagesBase, attachments: attachmentRecord }),
  operations: ['list', 'get'],
  embed: goodEmbed,
})
export const okInteractions = definePreparedResource({
  name: 'interactions',
  eventName: 'interaction',
  table: 'interactions',
  record: z.object(interactionsBase),
  operations: ['list', 'get'],
  filters: { thread_id: filter },
  joinFilters: { identity_id: { schema: z.uuid(), where: () => sql<boolean>`true` } },
})
export const okContactFiles = definePreparedResource({
  name: 'contact_files',
  eventName: 'contact_file',
  table: 'contact_files',
  record: z.object({ id: z.uuid(), contact_id: z.uuid(), file_id: z.uuid() }),
  references: { contact_id: { table: 'contacts', live: true }, file_id: { table: 'files' } },
})

// 1. a record naming `attachments` without an embed declaration
definePreparedResource({
  name: 'messages',
  eventName: 'message',
  table: 'messages',
  // @ts-expect-error attachments is not a column of messages and no embed declares it
  record: z.object({ ...messagesBase, attachments: attachmentRecord }),
  operations: ['list', 'get'],
})

// 2. an embed on a table that does not exist (the record leaves the field out: with no child table there is no array to type it by)
definePreparedResource({
  name: 'messages',
  eventName: 'message',
  table: 'messages',
  record: z.object(messagesBase),
  // @ts-expect-error 'bogus' is not a table
  embed: { attachments: { table: 'bogus', key: 'message_id', columns: ['id'], orderBy: ['position'] } },
})

// 3. an embed key that is not a column of the child table (single line: the directive covers the whole declaration)
definePreparedResource({
  name: 'messages',
  eventName: 'message',
  table: 'messages',
  record: z.object(messagesBase),
  // @ts-expect-error 'bogus' is not a column of message_attachments
  embed: { attachments: { table: 'message_attachments', key: 'bogus', columns: ['id'], orderBy: ['position'] } },
})

// 4. an embed column that is not a column of the child table
definePreparedResource({
  name: 'messages',
  eventName: 'message',
  table: 'messages',
  record: z.object(messagesBase),
  // @ts-expect-error 'bogus' is not a column of message_attachments
  embed: { attachments: { table: 'message_attachments', key: 'message_id', columns: ['bogus'], orderBy: ['position'] } },
})

// 5. the record field of an embed typed as a string, not an array
definePreparedResource({
  name: 'messages',
  eventName: 'message',
  table: 'messages',
  // @ts-expect-error an embed field is an array in the record
  record: z.object({ ...messagesBase, attachments: z.string() }),
  embed: goodEmbed,
})

// 6. a join filter whose `where` is not a boolean expression
definePreparedResource({
  name: 'interactions',
  eventName: 'interaction',
  table: 'interactions',
  record: z.object(interactionsBase),
  joinFilters: {
    identity_id: {
      schema: z.uuid(),
      // @ts-expect-error a join filter predicate is a boolean expression
      where: () => sql<string>`'x'`,
    },
  },
})

// 7. a reference to a table that is not an allowed target
definePreparedResource({
  name: 'contact_files',
  eventName: 'contact_file',
  table: 'contact_files',
  record: z.object({ id: z.uuid(), contact_id: z.uuid(), file_id: z.uuid() }),
  // @ts-expect-error threads is not a table a reference can name
  references: { file_id: { table: 'threads' } },
})

// 8. contact_id is not a column of interactions, so it cannot be a column filter (it is a join filter)
definePreparedResource({
  name: 'interactions',
  eventName: 'interaction',
  table: 'interactions',
  record: z.object(interactionsBase),
  // @ts-expect-error 'contact_id' is not a column of interactions
  filters: { contact_id: filter },
})

// 9. a public messaging column named in a record with the wrong type
definePreparedResource({
  name: 'messages',
  eventName: 'message',
  table: 'messages',
  // @ts-expect-error version is an integer, the record says string
  record: z.object({ id: z.uuid(), version: z.string() }),
  operations: ['list', 'get'],
})

// hidden messaging columns ([[CORE58]] P5): content_key and storage_key are secret columns
definePreparedResource({
  name: 'messages',
  eventName: 'message',
  table: 'messages',
  // @ts-expect-error content_key is a secret column
  record: z.object({ id: z.uuid(), content_key: z.string().nullable() }),
})
definePreparedResource({
  name: 'files',
  eventName: 'file',
  table: 'files',
  // @ts-expect-error storage_key is a secret column
  record: z.object({ id: z.uuid(), storage_key: z.string() }),
})
export const okHiddenMessages = definePreparedResource({ name: 'messages', eventName: 'message', table: 'messages', record: z.object({ id: z.uuid(), version: z.number().int() }) })
export const okHiddenFiles = definePreparedResource({ name: 'files', eventName: 'file', table: 'files', record: z.object({ id: z.uuid(), name: z.string() }) })
