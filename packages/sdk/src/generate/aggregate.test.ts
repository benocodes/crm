import { describe, expect, it } from 'vitest'
import { generateSdk, loadDocuments } from './index.js'

// DX616 D2: the generator reads `x-vibase-aggregate`, takes kinds from the operation's filters, refuses bad input and falls back without the extension.
const ok = {
  200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: {} } } } },
}
const filter = (name: string, kind: string) => ({
  name,
  in: 'query',
  required: false,
  schema: { type: 'string' },
  'x-vibase-filter': { kind, operators: ['eq'] },
})
const spec = (over: Record<string, unknown> = {}) => ({
  sum: ['amount'],
  avg: ['amount'],
  min: ['amount', 'name'],
  max: ['amount', 'name'],
  group_by: ['name'],
  money: { amount: 'currency' },
  ...over,
})
const documents = (
  extension: unknown,
  parameters: unknown[] = [filter('amount', 'integer'), filter('name', 'text')],
) => ({
  api: {
    openapi: '3.1.0',
    info: { title: 'a', version: '1' },
    paths: {
      '/things/aggregate': {
        get: {
          operationId: 'things.aggregate',
          parameters: [...parameters, { name: 'sum', in: 'query', schema: { type: 'string' } }],
          ...(extension === undefined ? {} : { 'x-vibase-aggregate': extension }),
          responses: ok,
        },
      },
    },
  },
  meta: { openapi: '3.1.0', info: { title: 'm', version: '1' }, paths: {} },
})

describe('DX616 D2 the generator reads the extension', () => {
  it('writes the type-level spec with each field kind taken from the filters, and the aggregate parameter names', async () => {
    const out = await generateSdk(documents(spec()))
    expect(out.types).toMatch(/aggregate: \{[^\n]*'amount': 'integer'[^\n]*'name': 'text'/)
    expect(out.operations).toContain('"aggregateParams"')
    expect(out.operations).toMatch(/"aggregateParams": \[\s*"avg",\s*"group_by",\s*"max",\s*"min",\s*"sum"\s*\]/)
  })

  it('a function with no field has no parameter name', async () => {
    const out = await generateSdk(documents(spec({ sum: [], avg: [] })))
    expect(out.operations).toMatch(/"aggregateParams": \[\s*"group_by",\s*"max",\s*"min"\s*\]/)
  })

  it.each([
    ['a non-array function list', spec({ sum: 'amount' }), /things\.aggregate.*sum/s],
    ['a non-string field', spec({ min: [1] }), /things\.aggregate.*min/s],
    ['a missing group_by', (({ group_by, ...rest }) => rest)(spec()), /things\.aggregate.*group_by/s],
    ['a malformed money map', spec({ money: [] }), /things\.aggregate.*money/s],
    ['an extension that is not an object', 'sum', /things\.aggregate/],
    ['a sum field that is not a filter parameter', spec({ sum: ['ghost'] }), /things\.aggregate.*"ghost"/s],
    ['a group_by field that is not a filter parameter', spec({ group_by: ['ghost'] }), /things\.aggregate.*"ghost"/s],
  ])('refuses %s, naming the operation and the field', async (_label, extension, message) => {
    const error = await generateSdk(documents(extension)).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(message)
  })

  it('an operation without the extension is emitted without any aggregate member', async () => {
    const out = await generateSdk(documents(undefined))
    expect(out.types).not.toContain('aggregate:')
    expect(out.operations).not.toContain('aggregateParams')
  })

  it('the production documents with the extension stripped generate exactly the output minus the aggregate additions', async () => {
    const full = await loadDocuments()
    const stripped = JSON.parse(JSON.stringify(full))
    for (const item of Object.values<any>(stripped.api.paths))
      for (const op of Object.values<any>(item)) if (op && typeof op === 'object') delete op['x-vibase-aggregate']
    const withExt = await generateSdk(full)
    const without = await generateSdk(stripped)
    expect(without.types).not.toContain('\n    aggregate: {')
    expect(without.operations).not.toContain('aggregateParams')
    const removeAdditions = (text: string) =>
      text.replace(/\n {4}aggregate: \{[^\n]*/g, '').replace(/,\n\s+"aggregateParams": \[[^\]]*\]/g, '')
    expect(removeAdditions(withExt.types)).toBe(without.types)
    expect(removeAdditions(withExt.operations)).toBe(without.operations)
    expect(withExt.types).toContain('\n    aggregate: {')
  }, 60_000)
})
