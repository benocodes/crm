import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { messages } from '../resources/messages.js'
import { threads } from '../resources/threads.js'

// API514 cycle 1 group 5: the content projection is dormant. No production operation, scope policy or consent area names the metadata scope,
// and messages and threads still require messages:read, so no caller below `messages:read` can reach a message. DELETE THIS FILE in API516
// (#516), whose scope makes the metadata scope live; its charter says so.
const NEEDLE = 'read_metadata'
const PACKAGES = ['../../../api/src', '../../../server-d1/src'].map((p) => join(import.meta.dirname, p))
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$|\.typecheck\.ts$/.test(name) ? [path] : []
  })
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join('\n')

describe('the metadata scope is not live yet', () => {
  it('no production source names it (code, not comments)', () => {
    const hits = PACKAGES.flatMap(sources).filter((f) => code(readFileSync(f, 'utf8')).includes(NEEDLE))
    expect(hits).toEqual([])
  })

  it('the registry declares no such scope and messages and threads still require messages:read', () => {
    const registry = createVibaseRegistry()
    expect(registry.declaredScopes().filter((s) => s.includes(NEEDLE))).toEqual([])
    expect(messages.scopeResource).toBe('messages')
    expect(threads.scopeResource).toBe('messages')
    for (const name of ['messages.list', 'messages.get', 'threads.list', 'threads.get']) {
      const op = registry.get(name)
      expect(op?.kind === 'tenant' ? op.scope : undefined, name).toEqual({ resource: 'messages', action: 'read' })
    }
    expect(registry.eventTypes().get('message')).toEqual({ scope: 'messages' })
  })
})
