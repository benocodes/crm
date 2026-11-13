import { describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { parseListQuery } from '../resources/define.js'
import { tasks } from '../resources/tasks.js'
import { deriveTools, splitArguments } from './tools.js'

// [[CORE201]] D9/D10: a list other than deals takes the grammar through its MCP tool.
const registry = createVibaseRegistry()
const entry = deriveTools(registry).find((t) => t.tool.name === 'tasks_list')!
const props = (entry.tool.inputSchema as { properties: Record<string, { type?: string; format?: string; description?: string }> }).properties

describe('tasks_list', () => {
  it('a column filter is a string argument with the operators of its kind; custom filters keep their schema', () => {
    for (const n of ['title', 'status', 'due_at', 'assignee_id', 'tag']) expect(props[n]?.type, n).toBe('string')
    expect(props.assignee_id!.format).toBeUndefined()
    expect(props.due_at!.description).toContain('Operators: eq, neq, gt, gte, lt, lte, in, is.')
    expect(props.tag_id!.format).toBe('uuid')
  })
  it('"lt.2026-12-01" reaches the list as the grammar', () => {
    const query = splitArguments(entry.op, { due_at: 'lt.2026-12-01', tag: 'consultancy' }).query
    expect(query).toEqual({ due_at: 'lt.2026-12-01', tag: 'consultancy' })
    expect(parseListQuery(tasks as any, { filters: query as Record<string, string> }).filters.due_at).toMatchObject({ op: 'lt', not: false })
  })
})
