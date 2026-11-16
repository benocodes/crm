import { describe, expect, it } from 'vitest'
import { Found, compileOperation, queryContext, type Dialect, type PreparedOperation } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { agents, createAgentOperation } from '../resources/agents.js'
import { ScopeSet } from '../scopes.js'
import type { PreparedEnv } from '../storage/definition.js'
import { updateOperation } from '../storage/crud.js'
import { getUserOperation } from './users.js'

// Pure checks of the administration programs (CORE40 Step 1.3): construction-time refusals and the compiled
// statements on both dialects. Nothing here touches a database.

const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AGENT = '0190b2c4-0000-7000-8000-00000000c001'
const NOW = new Date('2026-10-22T10:00:00.000Z')
let n = 0
const env: PreparedEnv = {
  actor: { id: USER, kind: 'user' },
  organizationId: ORG,
  scopes: ScopeSet.parse(['agents:read', 'agents:write', 'members:read']),
  now: NOW,
  newId: () => `0190b2c4-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  randomBytes: (k) => new Uint8Array(k).fill(7),
}
const dialects: readonly Dialect[] = ['postgres', 'd1']

const refusal = (fn: () => unknown): ApiError => {
  try {
    fn()
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('expected an ApiError')
}

describe('users.get (getUserOperation)', () => {
  it('an id that is not a UUID is a 404', () => {
    expect(refusal(() => getUserOperation(env, 'nope'))).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'user not found',
    })
  })
})

describe('agents.create (createAgentOperation)', () => {
  it.each(dialects)(
    'is a principal, an agent row, an event and a result on %s; the principal insert has no RETURNING',
    (dialect) => {
      const compiled = compileOperation(createAgentOperation(env, { name: 'a' }), dialect)
      expect(compiled.statements).toHaveLength(4)
      expect(compiled.statements.map((s) => s.label)).toEqual(['first-mutation', undefined, 'first-event', 'result'])
      expect(compiled.statements[0]!.sql).toMatch(/^insert into "principals"/i)
      expect(compiled.statements[0]!.sql).not.toMatch(/returning/i)
      expect(compiled.statements[1]!.sql).toMatch(/^insert into "agents"/i)
      expect(compiled.events.map((e) => e.type)).toEqual(['agent.created'])
    },
  )

  const build = (scopes: string[]): PreparedOperation<unknown> => createAgentOperation(env, { name: 'a', scopes })

  it('names the first offending scope, in input order', () => {
    expect(refusal(() => build(['tasks:read', 'zz:read']))).toMatchObject({
      status: 400,
      code: 'unknown_scope',
      message: 'unknown scope: zz:read',
    })
    expect(refusal(() => build(['members:read']))).toMatchObject({
      status: 400,
      code: 'scope_not_grantable',
      message: 'scope not grantable to an agent: members:read',
    })
  })

  it.each(dialects)('stores scopes deduplicated and sorted on %s', (dialect) => {
    const compiled = compileOperation(build(['tasks:write', 'tasks:read', 'tasks:write']), dialect)
    expect(compiled.statements[1]!.parameters).toContainEqual(['tasks:read', 'tasks:write'])
  })
})

describe('agents.update: a write field that is not a column is a hook input only', () => {
  it.each(dialects)('disabled drives disabled_at and is never written as a column on %s', (dialect) => {
    const before = {
      id: AGENT,
      organization_id: ORG,
      name: 'a',
      scopes: ['tasks:read'],
      disabled_at: null,
      created_by: USER,
      created_at: '2026-10-21T08:00:00.000Z',
      updated_at: '2026-10-21T08:00:00.000Z',
      auth_provider: null,
      auth_subject: null,
      auth_client_id: null,
      delegated_by: null,
      __stamp: '2026-10-21T08:00:00.000000Z',
    }
    const op = updateOperation(agents, env, AGENT, { disabled: true })
    const update = compileOperation(op, dialect, { before }).statements[0]!
    expect(update.sql).toMatch(/set .*"disabled_at"/i)
    expect(update.sql).toMatch(/"updated_at"/)
    expect(update.sql).not.toMatch(/"disabled"\s*=/)
  })
})
