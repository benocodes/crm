import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCOPE_AREAS } from '../auth/scope-areas.js'
import { SCOPE_DESCRIPTIONS, SCOPE_POLICY, scopesForRole } from '../auth/roles.js'
import { createVibaseRegistry } from '../operations.js'
import { ScopeSet, parseScope } from '../scopes.js'
import { messages } from '../resources/messages.js'
import { threads } from '../resources/threads.js'

// API514 cycle 1 group 5, narrowed by API518 (the grammar and the closure now put the bare action `read_metadata` in source, so the needle is the messages scope):
// the content projection is dormant. No production operation, scope policy or consent area names `messages:read_metadata`, and messages and threads still
// require messages:read, so no caller below `messages:read` can reach a message. DELETE THIS FILE in API516 (#516), whose scope makes the metadata scope live; its charter says so.
const declaredScopes = () => createVibaseRegistry().declaredScopes()
const NEEDLE = 'messages:read_metadata'
const PACKAGES = ['../../../api/src', '../../../server-d1/src'].map((p) => join(import.meta.dirname, p))
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$|\.suite\.ts$|\.typecheck\.ts$/.test(name) ? [path] : []
  })
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join('\n')

describe('the metadata scope is not live yet', () => {
  it('no policy row, scope description or consent area names it, and no declared scope does', () => {
    expect(Object.keys(SCOPE_POLICY).filter((s) => s.includes(NEEDLE))).toEqual([])
    expect(Object.keys(SCOPE_DESCRIPTIONS).filter((s) => s.includes(NEEDLE))).toEqual([])
    expect(declaredScopes()).not.toContain(NEEDLE)
    expect(SCOPE_AREAS.flatMap((a) => a.resources).filter((r) => r.includes('read_metadata'))).toEqual([])
  })

  it("every role and a messages:read agent hold exactly today's closed sets (no read_metadata anywhere)", () => {
    const declared = declaredScopes()
    // Today's closure, restated: the grants, plus request_approval beside each declared write.
    const today = (grants: string[]) =>
      [
        ...new Set([
          ...grants,
          ...grants.filter((g) => g.endsWith(':write')).map((g) => g.replace(/:write$/, ':request_approval')),
        ]),
      ]
        .filter((s) => declared.includes(s) || grants.includes(s))
        .sort()
    expect(scopesForRole('owner', declared).toStrings()).toEqual(today(declared))
    const member = declared.filter((s) => SCOPE_POLICY[s]?.member === true)
    expect(scopesForRole('member', declared).toStrings()).toEqual(today(member))
    expect(ScopeSet.closed(['messages:read'], declared).toStrings()).toEqual(['messages:read'])
    for (const set of [scopesForRole('owner', declared), scopesForRole('member', declared)])
      expect(set.toStrings().filter((s) => s.includes('read_metadata'))).toEqual([])
  })

  it('the grammar accepts the action but a grant or a request of it is refused as undeclared', () => {
    expect(parseScope(NEEDLE)).toEqual({ resource: 'messages', action: 'read_metadata' })
    expect(declaredScopes().includes(NEEDLE)).toBe(false)
  })

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
