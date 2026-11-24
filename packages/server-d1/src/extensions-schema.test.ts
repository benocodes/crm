import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extensionsJsonSchema } from '@vibase/api'

// [[CORE542]] D26, P6: the published JSON Schema is generated from the validator and checked in; this keeps them equal.
const FILE = new URL('../vibase-extensions.schema.json', import.meta.url)
describe('vibase-extensions.schema.json', () => {
  it('equals the schema generated from the validator', () => {
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(extensionsJsonSchema())
  })
  it('carries the version literal, the closed top level and the required keys', () => {
    const s = extensionsJsonSchema() as any
    expect(s.properties.version).toEqual({ type: 'number', const: 1 })
    expect(s.additionalProperties).toBe(false)
    expect(s.required).toEqual(expect.arrayContaining(['version', 'objects']))
    expect(Object.keys(s.properties).sort()).toEqual(['$schema', 'objects', 'version'])
  })
})
