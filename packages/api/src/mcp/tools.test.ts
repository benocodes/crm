import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createVaultRegistry } from '../operations.js'
import { Registry, toolName, type TenantOperation } from '../registry.js'
import { ApiError } from '../errors.js'
import { INSTRUCTIONS } from './instructions.js'
import { deriveTools, splitArguments } from './tools.js'

// [[API106]] cycle 1: tools derive from the registry (D7-D11) and the instructions name only real tools (D18).

const registry = createVaultRegistry()
const tools = deriveTools(registry)
const byName = (name: string) => tools.find((t) => t.tool.name === name)!
const nonBinary = registry.operations().filter((o) => o.output !== 'binary')

describe('tools derive from the registry', () => {
  it('every non-binary operation is a tool with its toolName, a D8 description and an object input schema', () => {
    expect(tools.map((t) => t.tool.name)).toEqual(nonBinary.map((o) => toolName(o.name)))
    expect(tools.length).toBeGreaterThan(30)
    for (const { op, tool } of tools) {
      expect(tool.title).toBe(op.summary)
      expect(tool.description.startsWith(op.summary)).toBe(true)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool._meta['vibase/surface']).toBe(op.surface)
      if (op.kind === 'tenant') expect(tool.description).toContain(`Requires ${op.scope.resource}:${op.scope.action} (${op.surface === 'api' ? 'records' : 'configuration'} surface).`)
    }
  })

  it('binary operations are not tools', () => {
    const binary = registry.operations().filter((o) => o.output === 'binary')
    expect(binary.map((o) => o.name)).toContain('files.content')
    for (const o of binary) expect(tools.map((t) => t.tool.name)).not.toContain(toolName(o.name))
  })

  it('me_get names no scope; a human-only meta tool names the configuration surface', () => {
    expect(byName('me_get').tool.description).not.toMatch(/Requires/)
    expect(byName('agents_list').tool.description).toContain('(configuration surface)')
  })

  it('flat input: path, query and body fields are siblings, required is the union', () => {
    const update = byName('contacts_update').tool.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(update.properties)).toContain('id')
    expect(Object.keys(update.properties).length).toBeGreaterThan(2)
    expect(update.required).toContain('id')
    const list = byName('contacts_list').tool.inputSchema as { properties: Record<string, unknown> }
    expect(Object.keys(list.properties)).toEqual(expect.arrayContaining(['after', 'limit']))
    const create = byName('contacts_create').tool.inputSchema as { properties: Record<string, unknown> }
    expect(create.properties).not.toHaveProperty('body')
  })

  it('list operations declare an output schema with data and next_cursor; a 204 operation declares none', () => {
    const out = byName('contacts_list').tool.outputSchema as { type: string; properties: Record<string, unknown> }
    expect(out.type).toBe('object')
    expect(Object.keys(out.properties).sort()).toEqual(['data', 'next_cursor'])
    expect(byName('contacts_delete').tool.outputSchema).toBeUndefined()
  })

  it('no flat name collides across params, query and body anywhere in the registry', () => {
    expect(() => deriveTools(createVaultRegistry())).not.toThrow()
  })

  it('a collision is an error at derivation', () => {
    const op: TenantOperation = {
      kind: 'tenant',
      name: 'things.update',
      surface: 'api',
      summary: 'Update',
      method: 'patch',
      path: '/things/{id}',
      scope: { resource: 'things', action: 'write' },
      request: { params: z.object({ id: z.string() }), body: z.object({ id: z.string() }) },
      response: { status: 204 },
      prepare: () => {
        throw new Error('unused')
      },
    }
    expect(() => deriveTools(new Registry().register(op))).toThrow(/more than one/)
  })
})

describe('splitting arguments (D9)', () => {
  const op = (name: string) => registry.get(name)!
  it('path and query values go over as strings, the rest into the body', () => {
    expect(splitArguments(op('contacts.update'), { id: '0190b2c4-0000-7000-8000-000000000001', name: 'Ada' })).toEqual({ params: { id: '0190b2c4-0000-7000-8000-000000000001' }, query: {}, body: { name: 'Ada' } })
    expect(splitArguments(op('contacts.list'), { limit: 5, after: 'x' })).toEqual({ params: {}, query: { limit: '5', after: 'x' }, body: undefined })
  })
  it('an unknown name reaches the body of an object body; with no body it is a validation error', () => {
    expect(splitArguments(op('contacts.create'), { name: 'Ada', nonsense: 1 }).body).toEqual({ name: 'Ada', nonsense: 1 })
    expect(() => splitArguments(op('contacts.list'), { nonsense: 1 })).toThrow(ApiError)
  })
})

describe('instructions (D18)', () => {
  const names = new Set(tools.map((t) => t.tool.name))
  it('are at most 1,200 characters', () => {
    expect(INSTRUCTIONS.length).toBeGreaterThan(200)
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(1200)
  })
  it('mention only tools that exist, and mention the ones the spec lists', () => {
    const mentioned = [...INSTRUCTIONS.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((m) => m[0]).filter((w) => w !== 'next_cursor')
    for (const name of ['me_get', 'schema_get', 'identities_resolve', 'companies_list']) expect(mentioned).toContain(name)
    for (const m of mentioned) expect(names, m).toContain(m)
  })
})
