import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { StatementFailed, type ExecutionResult, type PreparedOperation, type StatementLabel } from '@vibase/storage'
import { withFault } from '@vibase/storage/test'
import { seedAgent, seedOrganization, seedUser } from '@vibase/db/test'
import { ApiError, mapStorageError } from '../errors.js'
import { createVibaseRegistry } from '../operations.js'
import type { TenantOperation } from '../registry.js'
import { seedPrincipal } from '@vibase/storage-d1/test/seed'
import { openEngines, type Engine, type EngineName } from '../test/engines.js'
import { BASE } from '../test/identity-kit.js'

// Administration on both engines (CORE40 Step 2.4): agents, memberships and users through the real
// registry operations (async prepare included), against Postgres and D1 with the same assertions.
const registry = createVibaseRegistry()
const at = (n: number) => new Date(BASE + n * 60_000)
const iso = (n: number) => at(n).toISOString()
const TABLES = ['principals', 'agents', 'events'] as const
const snapshot = async (e: Engine) =>
  Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await e.rows(t)] as const)))
const UNKNOWN = '0190b2c4-0000-7000-8000-00000000dead'

type Call = { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }
type Opts = { now?: Date; as?: 'agent' | 'user' }

/** The suite body: one instance per engine entry file (`*.d1.test.ts`, `*.postgres.test.ts`). */
export function engineSuite(engineName: EngineName): void {
  let engines: Engine[]
  beforeAll(async () => {
    engines = await openEngines([engineName])
  })
  afterAll(async () => {
    for (const e of engines) await e.close()
  })

  describe.each([engineName])('administration storage behaviour on %s', (name) => {
    let e: Engine
    let tick = 0
    beforeAll(() => {
      e = engines.find((x) => x.name === name)!
    })
    beforeEach(async () => {
      await e.reset()
      tick = 100
    })

    /** One registry operation exactly as the REST adapter runs it: async prepare, then execute, storage errors mapped. */
    const prepareOp = async (op: string, call: Call, opts: Opts = {}): Promise<PreparedOperation<unknown>> => {
      const operation = registry.get(op) as TenantOperation
      return operation.prepare(e.env({ now: opts.now ?? at(++tick), ...(opts.as ? { as: opts.as } : {}) }), {
        params: {},
        query: {},
        body: undefined,
        ...call,
      })
    }
    const run = async (op: string, call: Call = {}, opts: Opts = {}): Promise<ExecutionResult<any>> => {
      try {
        return await e.run(await prepareOp(op, call, opts), opts.as)
      } catch (err) {
        throw mapStorageError(err)
      }
    }
    const call = async (op: string, c: Call = {}, opts: Opts = {}): Promise<any> => (await run(op, c, opts)).value
    const fail = async (op: string, c: Call = {}, opts: Opts = {}): Promise<readonly [number, string, string]> => {
      const err = await run(op, c, opts).then(
        () => undefined,
        (x: unknown) => x,
      )
      expect(err, `expected ${op} to fail`).toBeInstanceOf(ApiError)
      const a = err as ApiError
      return [a.status, a.code, a.message]
    }
    const events = async (prefix?: string) =>
      (await e.rows('events')).filter((x) => (prefix ? String(x.type).startsWith(prefix) : true))
    const newAgent = (body: Record<string, unknown> = {}, opts?: Opts) =>
      call('agents.create', { body: { name: 'bot', scopes: ['tasks:read'], ...body } }, opts)
    const row = async (table: 'agents' | 'memberships' | 'principals', id: string) => {
      const r = (await e.rows(table)).find((x) => x.id === id)
      expect(r, `${table} row ${id}`).toBeDefined()
      return r!
    }

    describe('agents', () => {
      it('create stores the principal and the agent row with one id, normalised scopes, one event, stamps = now', async () => {
        const principalsBefore = (await e.rows('principals')).length
        const a = await newAgent(
          { name: '  Bot  ', scopes: ['tasks:write', 'tasks:read', 'tasks:write'] },
          { now: at(1) },
        )
        expect(a).toEqual({
          id: a.id,
          organization_id: e.organizationId,
          name: 'Bot',
          scopes: ['tasks:read', 'tasks:write'],
          disabled_at: null,
          created_by: e.userId,
          created_at: iso(1),
          updated_at: iso(1),
          auth_provider: null,
          auth_subject: null,
          auth_client_id: null,
          delegated_by: null,
        })
        expect(await row('principals', a.id)).toMatchObject({ kind: 'agent', created_at: iso(1) })
        expect((await e.rows('principals')).length).toBe(principalsBefore + 1)
        expect(await row('agents', a.id)).toMatchObject({
          name: 'Bot',
          scopes: ['tasks:read', 'tasks:write'],
          disabled_at: null,
          created_by: e.userId,
          created_at: iso(1),
          updated_at: iso(1),
        })
        const ev = await events('agent.')
        expect(ev).toHaveLength(1)
        expect(ev[0]).toMatchObject({
          type: 'agent.created',
          resource_type: 'agent',
          resource_id: a.id,
          actor_id: e.userId,
          organization_id: e.organizationId,
          created_at: iso(1),
          before: null,
          after: a,
        })
      })

      it('create keeps messages:read_metadata alone, stored as given: declared and grantable, never closed into the row (API516)', async () => {
        const a = await call('agents.create', { body: { name: 'meta', scopes: ['messages:read_metadata'] } })
        expect(a.scopes).toEqual(['messages:read_metadata'])
        expect((await row('agents', a.id)).scopes).toEqual(['messages:read_metadata'])
      })

      it('create with no scopes stores an empty list', async () => {
        const a = await call('agents.create', { body: { name: 'empty' } })
        expect(a.scopes).toEqual([])
        expect((await row('agents', a.id)).scopes).toEqual([])
      })

      it.each([
        [
          'an unknown scope',
          { name: 'x', scopes: ['tasks:read', 'zz:read'] },
          [400, 'unknown_scope', 'unknown scope: zz:read'],
        ],
        [
          'a human-only scope',
          { name: 'x', scopes: ['members:read'] },
          [400, 'scope_not_grantable', 'scope not grantable to an agent: members:read'],
        ],
      ] as const)('create refuses %s and writes nothing', async (_n, body, expected) => {
        const before = await snapshot(e)
        expect(await fail('agents.create', { body })).toEqual(expected)
        expect(await snapshot(e)).toEqual(before)
      })

      it('create refuses a blank name and writes nothing', async () => {
        const before = await snapshot(e)
        const [status, code] = await fail('agents.create', { body: { name: '   ' } })
        expect([status, code]).toEqual([400, 'validation_error'])
        expect(await snapshot(e)).toEqual(before)
      })

      it('update renames, changes scopes at once, stamps updated_at and emits one event each', async () => {
        const a = await newAgent({}, { now: at(1) })
        const renamed = await call('agents.update', { params: { id: a.id }, body: { name: 'renamed' } }, { now: at(2) })
        expect(renamed).toMatchObject({
          name: 'renamed',
          created_at: iso(1),
          updated_at: iso(2),
          scopes: ['tasks:read'],
        })
        const scoped = await call(
          'agents.update',
          { params: { id: a.id }, body: { scopes: ['tasks:write', 'tasks:read'] } },
          { now: at(3) },
        )
        expect(scoped).toMatchObject({ scopes: ['tasks:read', 'tasks:write'], updated_at: iso(3) })
        expect(await row('agents', a.id)).toMatchObject({
          name: 'renamed',
          scopes: ['tasks:read', 'tasks:write'],
          updated_at: iso(3),
        })
        const ev = (await events('agent.updated')).map((x) => [x.created_at, x.before.name, x.after.name])
        expect(ev).toEqual([
          [iso(2), 'bot', 'renamed'],
          [iso(3), 'renamed', 'renamed'],
        ])
        // [[CORE662]] D10: the answer carries `sign_in_notice` (null for an API-key agent); the event holds the record alone.
        expect(scoped.sign_in_notice).toBeNull()
        const { sign_in_notice: _notice, ...scopedRecord } = scoped
        expect((await events('agent.updated'))[1]!.after).toEqual(scopedRecord)
      })

      it('update refuses a bad scope with nothing written', async () => {
        const a = await newAgent()
        const before = await snapshot(e)
        expect(await fail('agents.update', { params: { id: a.id }, body: { scopes: ['agents:write'] } })).toEqual([
          400,
          'scope_not_grantable',
          'scope not grantable to an agent: agents:write',
        ])
        expect(await snapshot(e)).toEqual(before)
      })

      it('disable stamps disabled_at once, a second disable keeps the first, enable clears it', async () => {
        const a = await newAgent({}, { now: at(1) })
        const off = await call('agents.update', { params: { id: a.id }, body: { disabled: true } }, { now: at(2) })
        expect(off).toMatchObject({ disabled_at: iso(2), updated_at: iso(2) })
        const again = await call('agents.update', { params: { id: a.id }, body: { disabled: true } }, { now: at(3) })
        expect(again).toMatchObject({ disabled_at: iso(2), updated_at: iso(3) })
        const on = await call('agents.update', { params: { id: a.id }, body: { disabled: false } }, { now: at(4) })
        expect(on).toMatchObject({ disabled_at: null, updated_at: iso(4) })
        const stored = await row('agents', a.id)
        expect(stored).toMatchObject({ disabled_at: null, updated_at: iso(4) })
        expect(Object.keys(stored)).not.toContain('disabled')
        expect((await events('agent.updated')).map((x) => x.after.disabled_at)).toEqual([iso(2), iso(2), null])
      })

      it('an empty patch is a no-op with no event; a same-value patch is a real update with one', async () => {
        const a = await newAgent({}, { now: at(1) })
        const noop = await run('agents.update', { params: { id: a.id }, body: {} }, { now: at(2) })
        expect(noop.value).toMatchObject({ id: a.id, updated_at: iso(1) })
        expect(noop.events).toEqual([])
        expect(await events('agent.updated')).toHaveLength(0)
        const same = await call('agents.update', { params: { id: a.id }, body: { name: 'bot' } }, { now: at(3) })
        expect(same).toMatchObject({ name: 'bot', updated_at: iso(3) })
        expect(await events('agent.updated')).toHaveLength(1)
      })

      describe('scope deltas ([[AGT186]])', () => {
        const update = (id: string, body: Record<string, unknown>, opts?: Opts) =>
          call('agents.update', { params: { id }, body }, opts)
        const failUpdate = (id: string, body: Record<string, unknown>) =>
          fail('agents.update', { params: { id }, body })
        const STORED = ['tasks:read', 'tasks:write']
        const agentEvents = () => events('agent.updated')
        const twoScopes = () => newAgent({ scopes: STORED }, { now: at(1) })

        it.each([
          ['add only', { add_scopes: ['contacts:read'] }, ['contacts:read', 'tasks:read', 'tasks:write']],
          ['remove only', { remove_scopes: ['tasks:write'] }, ['tasks:read']],
          [
            'add and remove',
            { add_scopes: ['contacts:read'], remove_scopes: ['tasks:write'] },
            ['contacts:read', 'tasks:read'],
          ],
          [
            'a duplicate within add_scopes',
            { add_scopes: ['contacts:read', 'contacts:read'] },
            ['contacts:read', 'tasks:read', 'tasks:write'],
          ],
          [
            'an unsorted add',
            { add_scopes: ['tasks:request_approval', 'contacts:read'] },
            ['contacts:read', 'tasks:read', 'tasks:request_approval', 'tasks:write'],
          ],
          ['remove of every scope', { remove_scopes: ['tasks:write', 'tasks:read'] }, []],
        ] as const)(
          '%s: stores the merged sorted list, answers with the record and emits one agent.updated with no delta fields',
          async (_n, body, expected) => {
            const a = await twoScopes()
            const result = await update(a.id, { ...body }, { now: at(2) })
            expect(result).toEqual({ ...a, scopes: expected, updated_at: iso(2), sign_in_notice: null })
            expect(await row('agents', a.id)).toMatchObject({ scopes: expected, updated_at: iso(2) })
            const ev = await agentEvents()
            expect(ev).toHaveLength(1)
            expect(ev[0]!.before).toEqual(a)
            const { sign_in_notice: _notice, ...resultRecord } = result
            expect(ev[0]!.after).toEqual(resultRecord)
            expect(Object.keys(ev[0]!.after).sort()).toEqual(Object.keys(a).sort())
            expect(Object.keys(ev[0]!.before).sort()).toEqual(Object.keys(a).sort())
          },
        )

        it('a delta combines with name and with disabled in one update and one event', async () => {
          const a = await twoScopes()
          const named = await update(a.id, { name: 'renamed', add_scopes: ['contacts:read'] }, { now: at(2) })
          expect(named).toMatchObject({
            name: 'renamed',
            scopes: ['contacts:read', 'tasks:read', 'tasks:write'],
            updated_at: iso(2),
          })
          const off = await update(a.id, { disabled: true, remove_scopes: ['tasks:write'] }, { now: at(3) })
          expect(off).toMatchObject({
            disabled_at: iso(3),
            scopes: ['contacts:read', 'tasks:read'],
            updated_at: iso(3),
          })
          expect(await agentEvents()).toHaveLength(2)
        })

        describe('refusals write nothing', () => {
          it.each([
            [
              'scopes with add_scopes',
              { scopes: ['tasks:read'], add_scopes: ['contacts:read'] },
              ['scopes', 'add_scopes'],
            ],
            [
              'scopes with remove_scopes',
              { scopes: ['tasks:read'], remove_scopes: ['tasks:write'] },
              ['scopes', 'remove_scopes'],
            ],
            [
              'scopes with both deltas',
              { scopes: [], add_scopes: [], remove_scopes: [] },
              ['scopes', 'add_scopes', 'remove_scopes'],
            ],
          ] as const)('D1: %s is 400 validation_error naming the fields', async (_n, body, named) => {
            const a = await twoScopes()
            const before = await snapshot(e)
            const [status, code, message] = await failUpdate(a.id, { ...body })
            expect([status, code]).toEqual([400, 'validation_error'])
            for (const f of named) expect(message).toContain(f)
            expect(await snapshot(e)).toEqual(before)
          })

          it('D2: a scope in both deltas is 400 naming the first overlap in add_scopes order', async () => {
            const a = await twoScopes()
            const before = await snapshot(e)
            const [status, code, message] = await failUpdate(a.id, {
              add_scopes: ['contacts:read', 'tasks:write', 'tasks:read'],
              remove_scopes: ['tasks:read', 'tasks:write'],
            })
            expect([status, code]).toEqual([400, 'validation_error'])
            expect(message).toContain('tasks:write')
            expect(message).not.toContain('tasks:read')
            expect(await snapshot(e)).toEqual(before)
          })

          it('D2: an overlap whose net merge would equal the stored list is still 400, not a no-op 200', async () => {
            const a = await twoScopes()
            const [status, code] = await failUpdate(a.id, { add_scopes: ['tasks:read'], remove_scopes: ['tasks:read'] })
            expect([status, code]).toEqual([400, 'validation_error'])
          })

          it('validation order: an overlap that also has an unknown add reports the overlap (D2 before D3)', async () => {
            const a = await twoScopes()
            const [status, code, message] = await failUpdate(a.id, {
              add_scopes: ['nope:read', 'tasks:read'],
              remove_scopes: ['tasks:read'],
            })
            expect([status, code]).toEqual([400, 'validation_error'])
            expect(message).toContain('tasks:read')
          })

          it('validation order: scopes with a delta for an unknown agent id is 400, not 404; a valid body for it is 404', async () => {
            expect((await failUpdate(UNKNOWN, { scopes: [], add_scopes: [] }))[0]).toBe(400)
            expect((await failUpdate(UNKNOWN, { add_scopes: ['nope:read'] }))[1]).toBe('unknown_scope')
            expect(await failUpdate(UNKNOWN, { add_scopes: ['contacts:read'] })).toEqual([
              404,
              'not_found',
              'agent not found',
            ])
            expect(await failUpdate(UNKNOWN, { remove_scopes: ['tasks:read'] })).toEqual([
              404,
              'not_found',
              'agent not found',
            ])
          })

          it.each([
            ['an unknown field', { add_scopes: ['contacts:read'], extra: 1 }],
            ['a non-array add_scopes', { add_scopes: 'contacts:read' }],
            ['a non-string remove entry', { remove_scopes: [1] }],
            ['more than 100 removes', { remove_scopes: Array.from({ length: 101 }, (_, i) => `x${i}:read`) }],
            ['more than 100 adds', { add_scopes: Array.from({ length: 101 }, () => 'tasks:read') }],
          ] as const)('shape: %s is 400 validation_error', async (_n, body) => {
            const a = await twoScopes()
            const before = await snapshot(e)
            expect((await failUpdate(a.id, { ...body }))[1]).toBe('validation_error')
            expect(await snapshot(e)).toEqual(before)
          })
        })

        describe('D3 adds', () => {
          it('an unknown add is unknown_scope and a non-grantable add is scope_not_grantable, nothing written', async () => {
            const a = await twoScopes()
            const before = await snapshot(e)
            expect(await failUpdate(a.id, { add_scopes: ['nope:read'] })).toEqual([
              400,
              'unknown_scope',
              'unknown scope: nope:read',
            ])
            expect(await failUpdate(a.id, { add_scopes: ['agents:write'] })).toEqual([
              400,
              'scope_not_grantable',
              'scope not grantable to an agent: agents:write',
            ])
            expect(await snapshot(e)).toEqual(before)
          })

          it('the first offender in input order decides, in both orders', async () => {
            const a = await twoScopes()
            expect(await failUpdate(a.id, { add_scopes: ['contacts:read', 'nope:read', 'agents:write'] })).toEqual([
              400,
              'unknown_scope',
              'unknown scope: nope:read',
            ])
            expect(await failUpdate(a.id, { add_scopes: ['agents:write', 'nope:read'] })).toEqual([
              400,
              'scope_not_grantable',
              'scope not grantable to an agent: agents:write',
            ])
          })

          it('a stored scope the policy no longer declares does not block an unrelated add, and survives the merge', async () => {
            const a = await twoScopes()
            await e.update('agents', a.id, { scopes: ['legacy:read', 'tasks:read'] })
            const r = await update(a.id, { add_scopes: ['contacts:read'] }, { now: at(2) })
            expect(r.scopes).toEqual(['contacts:read', 'legacy:read', 'tasks:read'])
            expect((await row('agents', a.id)).scopes).toEqual(['contacts:read', 'legacy:read', 'tasks:read'])
          })

          it('D4: removes are literal and unchecked: an undeclared stored scope can be removed by name', async () => {
            const a = await twoScopes()
            await e.update('agents', a.id, { scopes: ['legacy:read', 'tasks:read'] })
            const r = await update(a.id, { remove_scopes: ['legacy:read', 'agents:write', 'whatever'] }, { now: at(2) })
            expect(r.scopes).toEqual(['tasks:read'])
          })
        })

        describe('D7 no-op', () => {
          it.each([
            ['adding only stored scopes', { add_scopes: ['tasks:read', 'tasks:write'] }],
            ['removing only absent scopes', { remove_scopes: ['contacts:read'] }],
            ['removing an undeclared name', { remove_scopes: ['nope:read'] }],
            ['removing a non-grantable name', { remove_scopes: ['agents:write'] }],
            ['empty arrays', { add_scopes: [], remove_scopes: [] }],
            ['an empty add', { add_scopes: [] }],
            ['an empty remove', { remove_scopes: [] }],
          ] as const)('%s: 200 with the current record, no event, updated_at unchanged', async (_n, body) => {
            const a = await twoScopes()
            const before = await snapshot(e)
            const r = await run('agents.update', { params: { id: a.id }, body: { ...body } }, { now: at(2) })
            expect(r.value).toEqual({ ...a, sign_in_notice: null })
            expect(r.events).toEqual([])
            expect(await agentEvents()).toHaveLength(0)
            expect((await row('agents', a.id)).updated_at).toBe(iso(1))
            expect(await snapshot(e)).toEqual(before)
          })

          it('with name or disabled present a net-zero delta is a normal update writing the merged list, with one event', async () => {
            const a = await twoScopes()
            const named = await update(a.id, { name: 'bot', add_scopes: ['tasks:read'] }, { now: at(2) })
            expect(named).toMatchObject({ name: 'bot', scopes: STORED, updated_at: iso(2) })
            expect(await agentEvents()).toHaveLength(1)
            const off = await update(a.id, { disabled: false, remove_scopes: ['contacts:read'] }, { now: at(3) })
            expect(off).toMatchObject({ scopes: STORED, updated_at: iso(3) })
            expect(await agentEvents()).toHaveLength(2)
          })

          it('an invalid no-op is still refused (an unknown add that is also stored is not a stored scope check)', async () => {
            const a = await twoScopes()
            await e.update('agents', a.id, { scopes: ['legacy:read'] })
            expect(await failUpdate(a.id, { add_scopes: ['legacy:read'] })).toEqual([
              400,
              'unknown_scope',
              'unknown scope: legacy:read',
            ])
          })
        })

        it('the generic path is unchanged: replace scopes, name, disabled and {} still behave as before', async () => {
          const a = await twoScopes()
          expect(await update(a.id, { scopes: ['contacts:read'] }, { now: at(2) })).toMatchObject({
            scopes: ['contacts:read'],
            updated_at: iso(2),
          })
          expect(await update(a.id, { name: 'n' }, { now: at(3) })).toMatchObject({
            name: 'n',
            scopes: ['contacts:read'],
            updated_at: iso(3),
          })
          expect(await agentEvents()).toHaveLength(2)
          const noop = await run('agents.update', { params: { id: a.id }, body: {} }, { now: at(4) })
          expect(noop.events).toEqual([])
        })
      })

      it('an unknown or foreign-shaped id is a 404', async () => {
        expect(await fail('agents.update', { params: { id: UNKNOWN }, body: { name: 'x' } })).toEqual([
          404,
          'not_found',
          'agent not found',
        ])
        expect(await fail('agents.get', { params: { id: 'nope' } })).toEqual([404, 'not_found', 'agent not found'])
      })

      it('has no delete operation', () => {
        expect(registry.get('agents.delete')).toBeUndefined()
        expect(registry.get('api_keys.delete')).toBeUndefined()
      })

      it("list and get read the organisation's agents", async () => {
        const a = await newAgent()
        const list = await call('agents.list', { query: {} })
        expect(list.data.map((x: any) => x.id)).toEqual(expect.arrayContaining([a.id, e.agentId]))
        expect(list.data.find((x: any) => x.id === a.id)).toEqual(a)
        expect(await call('agents.get', { params: { id: a.id } })).toEqual(a)
      })
    })

    describe('memberships', () => {
      it('list returns the owner and the member; filters by role and user; a removed membership is neither listed nor found', async () => {
        const all = await call('memberships.list', { query: {} })
        expect(all.data.map((m: any) => [m.user_id, m.role]).sort()).toEqual(
          [
            [e.userId, 'owner'],
            [e.user2Id, 'member'],
          ].sort(),
        )
        expect((await call('memberships.list', { query: { role: 'owner' } })).data.map((m: any) => m.user_id)).toEqual([
          e.userId,
        ])
        expect(
          (await call('memberships.list', { query: { user_id: e.user2Id } })).data.map((m: any) => m.user_id),
        ).toEqual([e.user2Id])
        const extra = await e.seedMember('member')
        expect((await call('memberships.get', { params: { id: extra.membershipId } })).user_id).toBe(extra.userId)
        await e.update('memberships', extra.membershipId, { deleted_at: iso(1), updated_at: iso(1) })
        expect((await call('memberships.list', { query: {} })).data.map((m: any) => m.id)).not.toContain(
          extra.membershipId,
        )
        expect(await fail('memberships.get', { params: { id: extra.membershipId } })).toEqual([
          404,
          'not_found',
          'membership not found',
        ])
      })

      // [[CORE288]]: a role change and a removal exist ([[CORE41]]'s directory sync stays the writer on Clerk); there is still no create (a membership is made by accepting an invitation).
      it('has update and delete but no create', () => {
        expect(registry.get('memberships.create')).toBeUndefined()
        for (const op of ['update', 'delete']) expect(registry.get(`memberships.${op}`), op).toBeDefined()
      })
    })

    describe('users', () => {
      it('list returns live members only, keyset by id: each user once and then a null cursor', async () => {
        const extra = await e.seedMember('member')
        const expected = [e.userId, e.user2Id, extra.userId].sort()
        const seen: string[] = []
        let after: string | undefined
        for (let i = 0; i < 10; i++) {
          const page = await call('users.list', { query: { limit: 1, ...(after ? { after } : {}) } })
          expect(page.data).toHaveLength(1)
          seen.push(page.data[0].id)
          if (page.next_cursor === null) break
          after = page.next_cursor
        }
        expect(seen).toEqual(expected)
        const all = await call('users.list', { query: {} })
        expect(all.next_cursor).toBeNull()
        expect(all.data.map((u: any) => u.id)).toEqual(expected)
        expect(Object.keys(all.data[0]).sort()).toEqual(['created_at', 'email', 'id', 'name', 'updated_at'])
        await e.update('memberships', extra.membershipId, { deleted_at: iso(1), updated_at: iso(1) })
        expect((await call('users.list', { query: {} })).data.map((u: any) => u.id)).toEqual(
          [e.userId, e.user2Id].sort(),
        )
      })

      it('get finds a live member and a removed member, and 404s a user with no membership here', async () => {
        const extra = await e.seedMember('member')
        expect((await call('users.get', { params: { id: extra.userId } })).id).toBe(extra.userId)
        await e.update('memberships', extra.membershipId, { deleted_at: iso(1), updated_at: iso(1) })
        expect((await call('users.get', { params: { id: extra.userId } })).id).toBe(extra.userId)
        expect(await fail('users.get', { params: { id: UNKNOWN } })).toEqual([404, 'not_found', 'user not found'])
        expect(await fail('users.get', { params: { id: 'nope' } })).toEqual([404, 'not_found', 'user not found'])
      })

      if (name === 'd1') {
        it('users.get: a user with no membership row (seeded directly) is 404 and absent from the list', async () => {
          const loner = '0190b2c4-0000-7000-8000-00000000f001'
          await seedPrincipal(e.d1!, { id: loner, kind: 'user' })
          expect(await fail('users.get', { params: { id: loner } })).toEqual([404, 'not_found', 'user not found'])
          expect((await call('users.list', { query: {} })).data.map((u: any) => u.id)).not.toContain(loner)
        })
      } else {
        it("users.get: another organisation's user is 404 and absent from the list", async () => {
          const org = await seedOrganization(e.app!, { name: 'Foreign' })
          const foreign = await seedUser(e.app!, { organizationId: org.id, role: 'owner' })
          expect(await fail('users.get', { params: { id: foreign.id } })).toEqual([404, 'not_found', 'user not found'])
          expect((await call('users.list', { query: {} })).data.map((u: any) => u.id)).not.toContain(foreign.id)
        })
      }
    })

    describe('clock parity (D2): every stamp is the unit clock, the response, the row and the event agree', () => {
      it('agent create and update', async () => {
        const a = await newAgent({}, { now: at(1) })
        expect(a).toMatchObject({ created_at: iso(1), updated_at: iso(1) })
        expect(await row('principals', a.id)).toMatchObject({ created_at: iso(1) })
        const u = await call(
          'agents.update',
          { params: { id: a.id }, body: { disabled: true, name: 'n' } },
          { now: at(2) },
        )
        expect(u).toMatchObject({ updated_at: iso(2), disabled_at: iso(2) })
        expect(await row('agents', a.id)).toMatchObject({ updated_at: iso(2), disabled_at: iso(2) })
        const ev = (await e.rows('events')).filter((x) => x.type.startsWith('agent.'))
        expect(ev.map((x) => [x.type, x.created_at])).toEqual([
          ['agent.created', iso(1)],
          ['agent.updated', iso(2)],
        ])
        const { sign_in_notice: _notice, ...updated } = u
        expect(ev[1]!.after).toEqual(updated)
      })
    })

    describe('statement counts', () => {
      it('are constant, and printed for RESULT.md', async () => {
        const a = await run('agents.create', { body: { name: 'c' } })
        const b = await run('agents.update', { params: { id: a.value.id }, body: { name: 'd' } })
        const l = await run('users.list', { query: {} })
        const counts = {
          'agent create': a.stats.statements,
          'agent update': b.stats.statements,
          'users.list': l.stats.statements,
        }
        console.log(`[statements] ${name} ${JSON.stringify(counts)}`)
        for (const n of Object.values(counts)) expect(n).toBeGreaterThan(0)
        // a second agent create costs exactly the same (no per-row work)
        const a2 = await run('agents.create', { body: { name: 'c2', scopes: ['tasks:read', 'tasks:write'] } })
        expect(a2.stats.statements).toBe(a.stats.statements)
      })
    })

    describe('atomicity: a failure at the first mutation, first event or result rolls everything back', () => {
      const labels: StatementLabel[] = ['first-mutation', 'first-event', 'result']
      const cases: Record<string, () => Promise<() => Promise<PreparedOperation<unknown>>>> = {
        'agent create': async () => () => prepareOp('agents.create', { body: { name: 'f', scopes: ['tasks:read'] } }),
        'agent update': async () => {
          const a = await newAgent()
          return () => prepareOp('agents.update', { params: { id: a.id }, body: { name: 'z', disabled: true } })
        },
      }
      for (const [label, prepare] of Object.entries(cases)) {
        it.each(labels)(`${label}: a real constraint fault after %s changes nothing`, async (after) => {
          const make = await prepare()
          const before = await snapshot(e)
          const err = await e.run(withFault(await make(), { after })).then(
            () => null,
            (x: unknown) => x,
          )
          expect(err).toBeInstanceOf(StatementFailed)
          expect(await snapshot(e)).toEqual(before)
        })
      }
    })

    if (name === 'd1') {
      describe('D1 drift: what changed between the plan and the commit batch aborts the unit', () => {
        const keyed = async () => ({ a: await newAgent({}, { now: at(1) }) })

        it('agent update vs update: a direct rename between plan and commit is 409 and the direct name stays', async () => {
          const { a } = await keyed()
          e.betweenPlanAndCommit(async () => {
            await e.update('agents', a.id, { name: 'direct', updated_at: iso(5) })
          })
          expect(
            (await fail('agents.update', { params: { id: a.id }, body: { name: 'planned' } }, { now: at(6) }))[1],
          ).toBe('conflict')
          expect(await row('agents', a.id)).toMatchObject({ name: 'direct' })
          expect((await events('agent.updated')).length).toBe(0)
        })

        it('agent delta update vs update: a direct change between plan and commit is 409 conflict, the merge is from the one guarded read and nothing is written (AGT186 D5)', async () => {
          const { a } = await keyed()
          e.betweenPlanAndCommit(async () => {
            await e.update('agents', a.id, { scopes: ['contacts:read'], updated_at: iso(5) })
          })
          expect(
            await fail(
              'agents.update',
              { params: { id: a.id }, body: { add_scopes: ['tasks:write'] } },
              { now: at(6) },
            ),
          ).toEqual([409, 'conflict', 'the record changed while the operation was running; retry'])
          expect(await row('agents', a.id)).toMatchObject({ scopes: ['contacts:read'], updated_at: iso(5) })
          expect((await events('agent.updated')).length).toBe(0)
          const retry = await call(
            'agents.update',
            { params: { id: a.id }, body: { add_scopes: ['tasks:write'] } },
            { now: at(7) },
          )
          expect(retry.scopes).toEqual(['contacts:read', 'tasks:write'])
        })
      })
    }
  })
}
