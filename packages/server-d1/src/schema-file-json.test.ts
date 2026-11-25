import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { schemaFileSchema, schemaFileJsonSchema } from '@vibase/api'

// [[CORE542]] D26, P6: the published JSON Schema is generated from the validator and checked in; this keeps them equal.
const FILE = new URL('../vibase.schema.schema.json', import.meta.url)
describe('vibase.schema.schema.json', () => {
  it('equals the schema generated from the validator', () => {
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(schemaFileJsonSchema())
  })
  it('carries the version literal, the closed top level and the required keys', () => {
    const s = schemaFileJsonSchema() as any
    expect(s.properties.version).toEqual({ type: 'number', const: 1 })
    expect(s.additionalProperties).toBe(false)
    expect(s.required).toEqual(expect.arrayContaining(['version', 'define']))
    expect(Object.keys(s.properties).sort()).toEqual(['$schema', 'define', 'extend', 'version'])
  })
  it('validates the docs sample for real and limits extend to the four built-ins', () => {
    const sample = {
      version: 1,
      define: {},
      extend: {
        contacts: {
          fields: { tier__c: { kind: 'enum', values: ['standard', 'gold'], required: true, default: 'standard' } },
        },
      },
    }
    expect(schemaFileSchema.safeParse(sample).success).toBe(true)
    expect(schemaFileSchema.safeParse({ ...sample, extend: { messages: { fields: {} } } }).success).toBe(false)
    const s = schemaFileJsonSchema() as any
    expect(s.required).not.toContain('extend')
    expect(s.properties.extend.propertyNames.enum).toEqual(['contacts', 'companies', 'deals', 'tasks'])
    expect(s.properties.extend.propertyNames.type).toBe('string')
  })
})
