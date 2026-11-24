import { z } from 'zod'
import { normalizeDomain } from '../identity/normalize.js'
import { BOOKKEEPING_FIELDS, IDENTITY_FIELDS, type BuiltInDeclaration } from './builtin.js'

/** Companies ([[CORE554]]): an organisation the workspace deals with. The domain is normalised and checked unique in `resources/companies.ts`. */
export const companiesDeclaration = {
  table: 'companies',
  label: 'Companies',
  description:
    'An organisation the workspace deals with. Contacts point at their primary company; further links are associations.',
  fields: {
    ...IDENTITY_FIELDS,
    name: {
      kind: 'text',
      required: true,
      trim: true,
      minLength: 1,
      maxLength: 500,
      description: 'The company name.',
    },
    domain: {
      kind: 'text',
      nullable: true,
      unique: true,
      maxLength: 253,
      description: 'Its web or email domain, lowercase; unique among live companies.',
      filter: { schema: z.string().max(253), normalize: (v) => normalizeDomain(v as string) },
    },
    ...BOOKKEEPING_FIELDS,
  },
  sorts: ['name'],
} satisfies BuiltInDeclaration<'companies'>
