import { describe, expect, it } from 'vitest'
import { readSchemaFile } from './schema-file-module.js'

// [[CORE615]] D6: a stored schema file that already carries a field named after an aggregate parameter is an invalid file under this release: the module reports it as an error (the Worker fails closed on that,
// [[CORE315]] D28) and builds no definition, so `withAggregate` never throws while the Worker builds its registry.
describe('a stored file with a field named after an aggregate parameter', () => {
  it.each(['count', 'sum', 'avg', 'min', 'max', 'group_by'])('%s: the file is invalid, with no definitions', (name) => {
    const file = readSchemaFile(
      JSON.stringify({ version: 1, define: { projects__c: { fields: { [name]: { kind: 'integer' } } } } }),
    )
    expect(file.error).toEqual({ rule: 'reserved_name', path: `define.projects__c.fields.${name}` })
    expect(file.definitions).toEqual([])
  })
  it('a file whose fields are not reserved still loads, and its definition aggregates', () => {
    const file = readSchemaFile(
      JSON.stringify({ version: 1, define: { projects__c: { fields: { total: { kind: 'integer' } } } } }),
    )
    expect(file.error).toBeUndefined()
    expect((file.definitions[0] as { aggregate?: { fields: { sum: string[] } } }).aggregate?.fields.sum).toEqual([
      'total',
    ])
  })
})
