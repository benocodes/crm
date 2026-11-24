import { describe, expect, it } from 'vitest'
import { DeclarationError, RESERVED_NAMES, parseObjectDeclaration, parseObjectDeclarations } from './declaration.js'

// [[CORE315]] D6, D9, D18, D19, P1, P2: a declaration is plain data and a broken one is refused with the rule named (`DeclarationError.rule`, a stable code: the sentence is not asserted).
const field = { kind: 'text' } as const
const ok = (fields: Record<string, unknown> = { name: field }) => ({ label: 'Projects', fields })
const rule = (key: string, input: unknown): string | undefined => {
  try {
    parseObjectDeclaration(key, input)
    return undefined
  } catch (err) {
    if (err instanceof DeclarationError) return err.rule
    throw err
  }
}

describe('the key (D9)', () => {
  it.each([
    ['projects', 'key_suffix'], // no `__c`
    ['projects_c', 'key_suffix'], // one underscore
    ['projects__d', 'key_suffix'],
    ['my__projects__c', 'key_double_underscore'], // a double underscore inside
    ['Projects__c', 'key_shape'], // upper case
    ['1projects__c', 'key_shape'], // starts with a digit
    ['__c', 'key_shape'], // empty before the suffix
    ['project-s__c', 'key_shape'],
    ['projects___c', 'key_shape'], // a trailing underscore before the suffix
    [`${'a'.repeat(41)}__c`, 'key_length'],
  ])('refuses %s with %s', (key, expected) => {
    expect(rule(key, ok())).toBe(expected)
  })
  it('accepts 40 characters before the suffix', () => {
    expect(rule(`${'a'.repeat(40)}__c`, ok())).toBeUndefined()
  })
})

describe('a field name (D9)', () => {
  it.each([
    ['Name', 'field_name_shape'],
    ['9lives', 'field_name_shape'],
    ['trailing_', 'field_name_shape'],
    ['a__b', 'field_name_double_underscore'],
    ['extra__c', 'field_name_double_underscore'],
    ['a'.repeat(41), 'field_name_length'],
  ])('refuses %s with %s', (name, expected) => {
    expect(rule('projects__c', ok({ [name]: field }))).toBe(expected)
  })
  it('accepts 40 characters', () => {
    expect(rule('projects__c', ok({ ['a'.repeat(40)]: field }))).toBeUndefined()
  })
})

describe('the reserved names (D19)', () => {
  it('lists the bookkeeping columns, the list parameters and the CLI flags', () => {
    expect([...RESERVED_NAMES].sort()).toEqual(
      [
        'id',
        'organization_id',
        'created_by',
        'created_at',
        'updated_at',
        'deleted_at',
        'additional_props',
        'after',
        'limit',
        'sort',
        'order',
        'q',
        'tag',
        'tag_id',
        'data',
        'all',
        'refresh',
        'profile',
        'server',
        'output',
        'help',
      ].sort(),
    )
  })
  it.each([
    'id',
    'organization_id',
    'created_by',
    'created_at',
    'updated_at',
    'deleted_at',
    'additional_props',
    'after',
    'limit',
    'sort',
    'order',
    'q',
    'tag',
    'tag_id',
    'data',
    'all',
    'refresh',
    'profile',
    'server',
    'output',
    'help',
  ])('refuses a field named %s', (name) => {
    expect(rule('projects__c', ok({ [name]: field }))).toBe('reserved_name')
  })
})

describe('a field (D18)', () => {
  it('refuses an unknown kind', () => {
    expect(rule('projects__c', ok({ x: { kind: 'money' } }))).toBe('unknown_kind')
    expect(rule('projects__c', ok({ x: {} }))).toBe('unknown_kind')
  })
  it('refuses a default on a timestamp', () => {
    expect(rule('projects__c', ok({ x: { kind: 'timestamp', default: '2026-01-01T00:00:00.000Z' } }))).toBe(
      'default_on_timestamp',
    )
  })
  it('refuses values off an enum, and an enum with none or a repeat', () => {
    expect(rule('projects__c', ok({ x: { kind: 'text', values: ['a'] } }))).toBe('values_not_enum')
    expect(rule('projects__c', ok({ x: { kind: 'enum' } }))).toBe('values_empty')
    expect(rule('projects__c', ok({ x: { kind: 'enum', values: [] } }))).toBe('values_empty')
    expect(rule('projects__c', ok({ x: { kind: 'enum', values: ['a', 'a'] } }))).toBe('values_repeated')
  })
  it('refuses a default that does not fit its kind or its values', () => {
    expect(rule('projects__c', ok({ x: { kind: 'integer', default: 'a' } }))).toBe('default_invalid')
    expect(rule('projects__c', ok({ x: { kind: 'integer', default: 1.5 } }))).toBe('default_invalid')
    expect(rule('projects__c', ok({ x: { kind: 'integer', default: 2 ** 53 } }))).toBe('default_invalid')
    expect(rule('projects__c', ok({ x: { kind: 'boolean', default: 1 } }))).toBe('default_invalid')
    expect(rule('projects__c', ok({ x: { kind: 'text', default: 'a'.repeat(10_001) } }))).toBe('default_invalid')
    expect(rule('projects__c', ok({ x: { kind: 'enum', values: ['a'], default: 'b' } }))).toBe('default_invalid')
  })
  it('accepts a reference to each allowed target, a sibling and itself, and unique on text and integer ([[CORE541]] D21, D22)', () => {
    for (const target of ['companies', 'deals', 'tasks', 'principals', 'projects__c', 'tickets__c'])
      expect(
        parseObjectDeclarations({
          projects__c: ok({ x: { kind: 'reference', target } }),
          tickets__c: ok(),
        }).projects__c!.fields.x,
        target,
      ).toMatchObject({ kind: 'reference', target })
    const parsed = parseObjectDeclaration(
      'projects__c',
      ok({
        a: { kind: 'text', unique: true },
        b: { kind: 'integer', unique: true },
        c: { kind: 'text', unique: false },
      }),
    )
    expect(parsed.fields.a).toMatchObject({ kind: 'text', unique: true })
    expect(parsed.fields.b).toMatchObject({ kind: 'integer', unique: true })
  })
  it('refuses a reference to contacts by name, an unknown table, a missing target and an undeclared custom target', () => {
    const r = (target?: string) => ({ x: { kind: 'reference', ...(target === undefined ? {} : { target }) } })
    expect(rule('projects__c', ok(r('contacts')))).toBe('reference_contacts_later')
    expect(rule('projects__c', ok(r('notes')))).toBe('reference_target_unknown')
    expect(rule('projects__c', ok(r('events')))).toBe('reference_target_unknown')
    expect(rule('projects__c', ok(r()))).toBe('reference_target_missing')
    expect(() => parseObjectDeclarations({ projects__c: ok(r('tickets__c')) })).toThrowError(DeclarationError)
    try {
      parseObjectDeclarations({ projects__c: ok(r('tickets__c')) })
    } catch (err) {
      expect((err as DeclarationError).rule).toBe('reference_target_undeclared')
      expect((err as DeclarationError).path).toBe('projects__c.fields.x')
    }
  })
  it('refuses a target off a reference, and a default, values or unique on one', () => {
    expect(rule('projects__c', ok({ x: { kind: 'text', target: 'companies' } }))).toBe('unknown_property')
    expect(rule('projects__c', ok({ x: { kind: 'reference', target: 'companies', default: 'a' } }))).toBe(
      'default_on_reference',
    )
    expect(rule('projects__c', ok({ x: { kind: 'reference', target: 'companies', values: ['a'] } }))).toBe(
      'values_not_enum',
    )
    expect(rule('projects__c', ok({ x: { kind: 'reference', target: 'companies', unique: true } }))).toBe('unique_kind')
  })
  it.each(['boolean', 'timestamp', 'enum'])('refuses unique on %s', (kind) => {
    expect(rule('projects__c', ok({ x: { kind, ...(kind === 'enum' ? { values: ['a'] } : {}), unique: true } }))).toBe(
      'unique_kind',
    )
  })
  it('refuses a key it does not know and a body that is not an object', () => {
    expect(rule('projects__c', ok({ x: { kind: 'text', colour: 'red' } }))).toBe('unknown_property')
    expect(rule('projects__c', { label: 'P', fields: { x: field }, extra: 1 })).toBe('unknown_property')
    expect(rule('projects__c', null)).toBe('not_an_object')
    expect(rule('projects__c', { label: 'P' })).toBe('fields_missing')
  })
  it('accepts one declaration per kind, with every option', () => {
    const parsed = parseObjectDeclaration('projects__c', {
      label: 'Projects',
      description: 'Client work',
      fields: {
        name: { kind: 'text', label: 'Name', description: 'The title', required: true, default: 'untitled' },
        budget: { kind: 'integer', default: 0 },
        active: { kind: 'boolean', default: false },
        start_date: { kind: 'timestamp', required: false },
        stage: { kind: 'enum', values: ['planned', 'done'], default: 'planned' },
      },
    })
    expect(Object.keys(parsed.fields)).toEqual(['name', 'budget', 'active', 'start_date', 'stage'])
    expect(parsed.fields.stage).toMatchObject({ kind: 'enum', values: ['planned', 'done'], default: 'planned' })
    expect(parsed.fields.name).toMatchObject({ required: true, default: 'untitled' })
  })
})

describe('a map of declarations (P2)', () => {
  it('validates each object and names the object that broke a rule', () => {
    expect(Object.keys(parseObjectDeclarations({ projects__c: ok(), tickets__c: ok() }))).toEqual([
      'projects__c',
      'tickets__c',
    ])
    try {
      parseObjectDeclarations({ projects__c: ok(), tickets: ok() })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DeclarationError)
      expect((err as DeclarationError).rule).toBe('key_suffix')
      expect((err as DeclarationError).path).toBe('tickets')
    }
  })
  it('refuses a map that is not an object', () => {
    expect(() => parseObjectDeclarations([])).toThrow(DeclarationError)
  })
})
