import { describe, expect, it } from 'vitest'
import { DeclarationError, parseExtensionsFile } from '../index.js'
import { parseExtend } from './extend.js'

// [[CORE555]] P1, P2: the `extend` section's validator. One case per rule; tests assert the rule code and path, not the sentence. The envelope still refuses `extend` (P7).
const field = (f: Record<string, unknown>) => ({ contacts: { fields: { a__c: f } } })
const refusal = (input: unknown, custom: string[] = []): DeclarationError => {
  try {
    parseExtend(input, custom)
  } catch (e) {
    if (e instanceof DeclarationError) return e
    throw e
  }
  throw new Error('accepted')
}
const ofKind: Record<string, Record<string, unknown>> = {
  text: { kind: 'text', required: true, default: 'x', unique: true },
  integer: { kind: 'integer', default: 3 },
  boolean: { kind: 'boolean', default: false },
  timestamp: { kind: 'timestamp' },
  enum: { kind: 'enum', values: ['a', 'b'], default: 'a' },
  reference: { kind: 'reference', target: 'deals' },
}

describe('accepted (P1, P2)', () => {
  for (const object of ['contacts', 'companies', 'deals', 'tasks'])
    it(`${object}: one field of each kind`, () => {
      const fields = Object.fromEntries(Object.entries(ofKind).map(([k, f]) => [`${k}_f__c`, f]))
      const out = parseExtend({ [object]: { fields } })
      expect(Object.keys((out as any)[object]).sort()).toEqual(Object.keys(fields).sort())
      expect((out as any)[object].text_f__c).toEqual(ofKind.text)
    })
  it('a reference to each allowed target, a custom object of the same file included', () => {
    const fields = Object.fromEntries(
      ['companies', 'deals', 'tasks', 'principals', 'projects__c'].map((t) => [
        `${t.replace('__c', '')}_ref__c`,
        { kind: 'reference', target: t },
      ]),
    )
    expect(Object.keys(parseExtend({ deals: { fields } }, ['projects__c']).deals!)).toHaveLength(5)
  })
  it('an empty extend and an object with no fields', () => {
    expect(parseExtend({})).toEqual({})
    expect(parseExtend({ tasks: { fields: {} } })).toEqual({ tasks: {} })
  })
  it('exactly 90 fields', () => {
    const fields = Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`f${i}__c`, { kind: 'integer' }]))
    expect(Object.keys(parseExtend({ deals: { fields } }).deals!)).toHaveLength(90)
  })
})

describe('refused by rule (matrix)', () => {
  const longName = `${'a'.repeat(41)}__c`
  const cases: [string, unknown, string, string][] = [
    ['extend is not a map', [], 'not_an_object', 'extend'],
    ['a closed built-in', { messages: { fields: {} } }, 'object_closed', 'extend.messages'],
    ['another closed built-in', { identities: { fields: {} } }, 'object_closed', 'extend.identities'],
    ['an unknown object', { widgets: { fields: {} } }, 'object_unknown', 'extend.widgets'],
    [
      'a custom object key (declares its own fields)',
      { projects__c: { fields: {} } },
      'object_unknown',
      'extend.projects__c',
    ],
    ['an object that is not a map', { contacts: [] }, 'not_an_object', 'extend.contacts'],
    [
      'an unknown property on the object',
      { contacts: { fields: {}, label: 'x' } },
      'unknown_property',
      'extend.contacts.label',
    ],
    ['fields missing', { contacts: {} }, 'fields_missing', 'extend.contacts.fields'],
    [
      'a key without __c',
      { contacts: { fields: { plain: { kind: 'text' } } } },
      'field_key_suffix',
      'extend.contacts.fields.plain',
    ],
    [
      'a double underscore in the name',
      { contacts: { fields: { a__b__c: { kind: 'text' } } } },
      'field_name_double_underscore',
      'extend.contacts.fields.a__b__c',
    ],
    [
      'an uppercase name',
      { contacts: { fields: { Abc__c: { kind: 'text' } } } },
      'field_name_shape',
      'extend.contacts.fields.Abc__c',
    ],
    [
      'a name starting with a digit',
      { contacts: { fields: { '1a__c': { kind: 'text' } } } },
      'field_name_shape',
      'extend.contacts.fields.1a__c',
    ],
    [
      'a name of only the suffix',
      { contacts: { fields: { __c: { kind: 'text' } } } },
      'field_name_shape',
      'extend.contacts.fields.__c',
    ],
    [
      'a name over 40 characters',
      { contacts: { fields: { [longName]: { kind: 'text' } } } },
      'field_name_length',
      `extend.contacts.fields.${longName}`,
    ],
    [
      'a field that is not a map',
      { contacts: { fields: { a__c: 'text' } } },
      'not_an_object',
      'extend.contacts.fields.a__c',
    ],
    ['an unknown kind', field({ kind: 'money' }), 'unknown_kind', 'extend.contacts.fields.a__c'],
    [
      'an unknown property on the field',
      field({ kind: 'text', colour: 'red' }),
      'unknown_property',
      'extend.contacts.fields.a__c',
    ],
    ['unique on a boolean', field({ kind: 'boolean', unique: true }), 'unique_kind', 'extend.contacts.fields.a__c'],
    [
      'a reference to contacts',
      field({ kind: 'reference', target: 'contacts' }),
      'reference_contacts_later',
      'extend.contacts.fields.a__c',
    ],
    [
      'a reference to an unknown table',
      field({ kind: 'reference', target: 'messages' }),
      'reference_target_unknown',
      'extend.contacts.fields.a__c',
    ],
    [
      'a reference to an undeclared custom object',
      field({ kind: 'reference', target: 'ghost__c' }),
      'reference_target_undeclared',
      'extend.contacts.fields.a__c',
    ],
    [
      'a reference with no target',
      field({ kind: 'reference' }),
      'reference_target_missing',
      'extend.contacts.fields.a__c',
    ],
    [
      'a default on a reference',
      field({ kind: 'reference', target: 'deals', default: 'x' }),
      'default_on_reference',
      'extend.contacts.fields.a__c',
    ],
    [
      'a default on a timestamp',
      field({ kind: 'timestamp', default: '2026-01-01T00:00:00Z' }),
      'default_on_timestamp',
      'extend.contacts.fields.a__c',
    ],
    [
      'a default that fails its kind',
      field({ kind: 'integer', default: 'x' }),
      'default_invalid',
      'extend.contacts.fields.a__c',
    ],
    [
      'an enum default outside its values',
      field({ kind: 'enum', values: ['a'], default: 'b' }),
      'default_invalid',
      'extend.contacts.fields.a__c',
    ],
    ['an enum without values', field({ kind: 'enum' }), 'values_empty', 'extend.contacts.fields.a__c'],
    [
      '91 fields',
      {
        deals: { fields: Object.fromEntries(Array.from({ length: 91 }, (_, i) => [`f${i}__c`, { kind: 'integer' }])) },
      },
      'too_many_fields',
      'extend.deals.fields',
    ],
  ]
  for (const [name, input, rule, path] of cases)
    it(`${name} -> ${rule}`, () => {
      const e = refusal(input)
      expect({ rule: e.rule, path: e.path }).toEqual({ rule, path })
    })
})

describe('dormant (P7)', () => {
  it('the file envelope still refuses extend, with its own code', () => {
    try {
      parseExtensionsFile(JSON.stringify({ version: 1, objects: {}, extend: { contacts: { fields: {} } } }))
      throw new Error('accepted')
    } catch (e) {
      expect((e as DeclarationError).rule).toBe('extend_later')
    }
  })
})
