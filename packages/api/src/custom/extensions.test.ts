import { describe, expect, it } from 'vitest'
import { DeclarationError, MAX_FILE_BYTES, parseExtensionsFile } from '../index.js'

// [[CORE542]] D5, D26: the extensions file's envelope. Every refusal carries a stable rule code and a path; tests assert the code, not the sentence.
const file = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, objects: { projects__c: { fields: { name: { kind: 'text' } } } }, ...over })
const refused = (text: string): DeclarationError => {
  try {
    parseExtensionsFile(text)
  } catch (e) {
    if (e instanceof DeclarationError) return e
    throw e
  }
  throw new Error('the file was accepted')
}

describe('the envelope', () => {
  it('accepts a file with $schema and two cross-referencing objects', () => {
    const f = parseExtensionsFile(
      JSON.stringify({
        $schema: 'https://example.test/vibase-extensions.schema.json',
        version: 1,
        objects: {
          projects__c: { fields: { client: { kind: 'reference', target: 'clients__c' } } },
          clients__c: { fields: { name: { kind: 'text' }, project: { kind: 'reference', target: 'projects__c' } } },
        },
      }),
    )
    expect(Object.keys(f.objects)).toEqual(['projects__c', 'clients__c'])
    expect(f.version).toBe(1)
  })
  it('accepts a file with no objects', () => {
    expect(parseExtensionsFile(file({ objects: {} })).objects).toEqual({})
  })
  it('refuses a file over 256 KiB before parsing it (not even valid JSON is needed)', () => {
    expect(MAX_FILE_BYTES).toBe(256 * 1024)
    expect(refused('x'.repeat(MAX_FILE_BYTES + 1)).rule).toBe('file_too_large')
    expect(refused(`{"version":1,"objects":{},"pad":"${'x'.repeat(MAX_FILE_BYTES)}"}`).rule).toBe('file_too_large')
    expect(refused('x'.repeat(MAX_FILE_BYTES)).rule).toBe('invalid_json')
  })
  it('counts bytes, not characters', () => {
    expect(refused('é'.repeat(MAX_FILE_BYTES / 2 + 1)).rule).toBe('file_too_large')
  })
  it('refuses invalid JSON and a non-object top level', () => {
    expect(refused('{').rule).toBe('invalid_json')
    expect(refused('[]').rule).toBe('not_an_object')
    expect(refused('null').rule).toBe('not_an_object')
  })
  it.each([
    ['missing', undefined],
    ['2', 2],
    ['a string', '1'],
  ])('refuses version %s', (_n, v) => {
    const o: Record<string, unknown> = { objects: {} }
    if (v !== undefined) o.version = v
    const e = refused(JSON.stringify(o))
    expect(e.rule).toBe('version_invalid')
    expect(e.path).toBe('version')
  })
  it('refuses objects missing or not a map', () => {
    expect(refused(JSON.stringify({ version: 1 })).rule).toBe('objects_missing')
    const e = refused(JSON.stringify({ version: 1, objects: [] }))
    expect([e.rule, e.path]).toEqual(['not_an_object', 'objects'])
  })
  it('refuses a key without the __c suffix, with the path through the key', () => {
    const e = refused(file({ objects: { projects: { fields: {} } } }))
    expect([e.rule, e.path]).toEqual(['key_suffix', 'objects.projects'])
  })
  it('accepts extend: parsed with the file, objects kept (P1, D5, D26)', () => {
    const f = parseExtensionsFile(
      file({
        extend: {
          contacts: { fields: { tier__c: { kind: 'enum', values: ['a', 'b'], required: true, default: 'a' } } },
        },
      }),
    )
    expect(Object.keys(f.objects)).toEqual(['projects__c'])
    expect(f.extend).toEqual({
      contacts: { tier__c: { kind: 'enum', values: ['a', 'b'], required: true, default: 'a' } },
    })
  })
  it('a file without extend has no extend key', () => {
    expect('extend' in parseExtensionsFile(file())).toBe(false)
  })
  it('accepts an extend-only file and an extend reference to the file own custom object', () => {
    const f = parseExtensionsFile(
      file({ extend: { deals: { fields: { project__c: { kind: 'reference', target: 'projects__c' } } } } }),
    )
    expect(f.extend?.deals?.project__c?.kind).toBe('reference')
    expect(
      parseExtensionsFile(JSON.stringify({ version: 1, objects: {}, extend: { tasks: { fields: {} } } })).extend,
    ).toEqual({
      tasks: {},
    })
  })
  it.each([
    ['a closed built-in', { messages: { fields: {} } }, 'object_closed', 'extend.messages'],
    ['an unknown object', { widgets: { fields: {} } }, 'object_unknown', 'extend.widgets'],
    [
      'a field without the suffix',
      { contacts: { fields: { tier: { kind: 'text' } } } },
      'field_key_suffix',
      'extend.contacts.fields.tier',
    ],
    [
      'an unknown kind',
      { contacts: { fields: { a__c: { kind: 'money' } } } },
      'unknown_kind',
      'extend.contacts.fields.a__c',
    ],
    [
      'a contacts field that references contacts',
      { contacts: { fields: { a__c: { kind: 'reference', target: 'contacts' } } } },
      'reference_contacts_self',
      'extend.contacts.fields.a__c',
    ],
    [
      'a reference to a custom object not in the file',
      { deals: { fields: { a__c: { kind: 'reference', target: 'other__c' } } } },
      'reference_target_undeclared',
      'extend.deals.fields.a__c',
    ],
  ])('refuses extend: %s -> %s at %s', (_n, extend, rule, path) => {
    const e = refused(file({ extend }))
    expect([e.rule, e.path]).toEqual([rule, path])
  })
  it('refuses a non-object extend', () => {
    const e = refused(file({ extend: [] }))
    expect([e.rule, e.path]).toEqual(['not_an_object', 'extend'])
  })
  it('refuses any other top-level key by name', () => {
    const e = refused(file({ hooks: [] }))
    expect([e.rule, e.path]).toEqual(['unknown_key', 'hooks'])
  })
  it('refuses a non-string $schema', () => {
    expect(refused(file({ $schema: 3 })).rule).toBe('schema_invalid')
  })
  it('refuses a declaration error inside an object, with the path through the key', () => {
    const e = refused(file({ objects: { projects__c: { fields: { id: { kind: 'text' } } } } }))
    expect([e.rule, e.path]).toEqual(['reserved_name', 'objects.projects__c.fields.id'])
  })
  it('refuses a reference to an undeclared sibling', () => {
    const e = refused(
      file({ objects: { projects__c: { fields: { c: { kind: 'reference', target: 'clients__c' } } } } }),
    )
    expect([e.rule, e.path]).toEqual(['reference_target_undeclared', 'objects.projects__c.fields.c'])
  })
  it('refuses an object of 91 fields and accepts 90', () => {
    const fields = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { kind: 'text' }]))
    expect(
      parseExtensionsFile(file({ objects: { projects__c: { fields: fields(90) } } })).objects.projects__c,
    ).toBeDefined()
    const e = refused(file({ objects: { projects__c: { fields: fields(91) } } }))
    expect(e.rule).toBe('too_many_fields')
    expect(e.path).toBe('objects.projects__c.fields')
  })
})
