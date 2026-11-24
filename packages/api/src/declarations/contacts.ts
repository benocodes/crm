import { z } from 'zod'
import { BOOKKEEPING_FIELDS, IDENTITY_FIELDS, type BuiltInDeclaration } from './builtin.js'

/** Contacts ([[CORE554]]): a person the organisation deals with. */
export const contactsDeclaration = {
  table: 'contacts',
  label: 'Contacts',
  description: 'A person the organisation deals with. Addresses live in identities.',
  fields: {
    ...IDENTITY_FIELDS,
    name: {
      kind: 'text',
      nullable: true,
      trim: true,
      minLength: 1,
      maxLength: 500,
      description: 'The contact name; may be empty when only an address is known.',
    },
    company_id: {
      kind: 'reference',
      target: 'companies',
      nullable: true,
      label: 'Primary company',
      description: "The contact's primary company; further affiliations are associations.",
      filter: { schema: z.uuid() },
    },
    merged_into_id: {
      kind: 'reference',
      target: 'contacts',
      nullable: true,
      input: 'system',
      description:
        'Set when this contact was merged into another; the row is then deleted and this points at the survivor.',
    },
    ...BOOKKEEPING_FIELDS,
    // Derived ([[CORE131]]): present only for a caller holding `interactions:read`; the hooks that compute them stay in `resources/contact-activity.ts`.
    last_contacted_at: {
      kind: 'timestamp',
      nullable: true,
      derived: true,
      description: "When the latest outbound interaction with any of the contact's identities happened; null if none.",
      apiDescription:
        "When the latest outbound interaction with any of the contact's identities happened; null if none. Derived, read-only; present only with interactions:read.",
    },
    last_interacted_at: {
      kind: 'timestamp',
      nullable: true,
      derived: true,
      description:
        "When the latest interaction, in either direction, with any of the contact's identities happened; null if none.",
      apiDescription:
        "When the latest interaction, in either direction, with any of the contact's identities happened; null if none. Derived, read-only; present only with interactions:read.",
    },
  },
  sorts: ['name', 'last_contacted_at', 'last_interacted_at'],
} satisfies BuiltInDeclaration<'contacts'>
