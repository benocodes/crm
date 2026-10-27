import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CommitOutcomeUnknown,
  CommittedResultInvalid,
  SetLimitExceeded,
  StatementFailed,
  boundIds,
  defineOperation,
  memberOf,
  readSet,
  selectColumns,
  step,
  unit,
  uuidv7,
  type PreparedOperation,
  type StatementLabel,
  type StorageBinding,
} from '@vault/storage'
import { sql } from 'kysely'
import { clearD1 } from '@vault/storage-d1/test'
import { seedDeployment } from '@vault/storage-d1/test/seed'
import { withFault } from '@vault/storage/test'
import { postgresBinding } from '@vault/storage-postgres'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { createOperation, updateOperation } from './crud.js'
import { tasks } from '../resources/tasks.js'
import { generateApiKey, apiKeyAuthOperation } from '../auth/api-keys.js'
import { firstSightOperation } from '../auth/first-sight.js'
import { reconcileOperation, repairOperation } from '../directory/sync.js'
import { bootstrapOperation } from '../bootstrap.js'
import { openEngines, type Engine } from '../test/engines.js'

const LABELS: readonly StatementLabel[] = ['first-mutation', 'first-event', 'result']
const NOW = new Date('2026-10-22T10:00:00.000Z')
const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('atomicity on %s', (name) => {
  let e: Engine
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
  })

  describe.each(LABELS)('a real constraint fault after %s', (label) => {
    it('rolls back a create: no task, no event', async () => {
      const err = await settle(e.run(withFault(createOperation(tasks, e.env({ now: NOW }), { title: 'x' }), { after: label })))
      expect(err).toBeInstanceOf(StatementFailed)
      expect((err as StatementFailed).kind).toBe('not_null')
      expect(await e.tasks()).toHaveLength(0)
      expect(await e.events()).toHaveLength(0)
    })

    it('rolls back an update: row and event chain unchanged', async () => {
      const id = uuidv7()
      await e.insertTask({ id, title: 'before' })
      const before = await e.tasks()
      const err = await settle(e.run(withFault(updateOperation(tasks, e.env({ now: NOW }), id, { title: 'after', status: 'done' }), { after: label })))
      expect(err).toBeInstanceOf(StatementFailed)
      expect(await e.tasks()).toEqual(before)
      expect(await e.events()).toHaveLength(0)
    })
  })

  it('an over-cap synthetic program refuses and changes nothing, and the same program passes with a larger cap (D7, D8)', async () => {
    for (let i = 0; i < 5; i++) await e.insertTask({ id: uuidv7(), title: `t${i}` })
    const completeAll: PreparedOperation<number> = defineOperation({
      name: 'tasks.complete_all',
      mutates: true,
      reads: (qc) => ({ open: readSet(selectColumns(qc, 'tasks', ['id'])) }),
      build: (found, qc) => {
        const ids = found.all('open').map((r) => String(r.id))
        return unit({
          steps: [
            step(
              qc.db.updateTable('tasks').set({ status: 'done', updated_at: NOW.toISOString() }).where(memberOf(qc, 'tasks', 'id', boundIds(qc, ids))),
              'first-mutation',
            ),
          ],
          events: [],
          decode: () => ids.length,
        })
      },
    })
    const small: StorageBinding =
      name === 'postgres' ? postgresBinding(e.app!, { maxSetSize: 4 }) : d1Binding(e.d1!, { organizationId: e.organizationId, authProvider: e.authProvider, authOrgId: e.authOrgId, maxSetSize: 4 })
    const big: StorageBinding =
      name === 'postgres' ? postgresBinding(e.app!, { maxSetSize: 500 }) : d1Binding(e.d1!, { organizationId: e.organizationId, authProvider: e.authProvider, authOrgId: e.authOrgId, maxSetSize: 500 })
    const identity = { kind: 'tenant' as const, actorId: e.userId, organizationId: e.organizationId }
    const { execute } = await import('@vault/storage')
    const err = await settle(execute(small, identity, completeAll))
    expect(err).toBeInstanceOf(SetLimitExceeded)
    expect((await e.tasks()).map((t) => t.status)).toEqual(Array(5).fill('open'))
    expect((await execute(big, identity, completeAll)).value).toBe(5)
    expect((await e.tasks()).map((t) => t.status)).toEqual(Array(5).fill('done'))
  })

  if (name === 'postgres') {
    it('a malformed final record rolls the whole unit back before commit', async () => {
      const op = createOperation(tasks, e.env({ now: NOW }), { title: 'x' })
      const invalid: PreparedOperation<unknown> = { ...op, build: (found, qc) => ({ ...op.build(found, qc), decode: () => tasks.record.parse({ id: 'not a record' }) }) }
      const err = await settle(e.run(invalid))
      expect(err).toBeDefined()
      expect(await e.tasks()).toHaveLength(0)
      expect(await e.events()).toHaveLength(0)
    })
  }

  if (name === 'd1') {
    it('a decode failure after a valid commit is committed_result_invalid: the unit is committed, never replayed', async () => {
      const op = createOperation(tasks, e.env({ now: NOW }), { title: 'x' })
      const invalid: PreparedOperation<unknown> = { ...op, build: (found, qc) => ({ ...op.build(found, qc), decode: () => tasks.record.parse({ id: 'not a record' }) }) }
      const err = await settle(e.run(invalid))
      expect(err).toBeInstanceOf(CommittedResultInvalid)
      expect(await e.tasks()).toHaveLength(1)
      expect(await e.events()).toHaveLength(1)
    })

    it('a lost transport after the commit is commit_outcome_unknown: reported, not replayed, not success', async () => {
      const real = e.d1!
      let batches = 0
      const flaky: D1Like = {
        prepare: (q) => real.prepare(q),
        batch: async (statements) => {
          const results = await real.batch(statements)
          batches += 1
          if (statements.length >= 3) throw new Error('D1_ERROR: Network connection lost')
          return results
        },
      }
      const binding = d1Binding(flaky, { organizationId: e.organizationId, authProvider: e.authProvider, authOrgId: e.authOrgId })
      const { execute } = await import('@vault/storage')
      const err = await settle(execute(binding, { kind: 'tenant', actorId: e.userId, organizationId: e.organizationId }, createOperation(tasks, e.env({ now: NOW }), { title: 'x' })))
      expect(err).toBeInstanceOf(CommitOutcomeUnknown)
      expect(batches).toBe(1) // an assignee-free create has no plan-phase reads: exactly one batch ran, and it was not replayed
      expect(await e.tasks()).toHaveLength(1)
    })
  }
})

// ---- auth and directory units (CORE41 Step 2.6): a real constraint fault anywhere rolls the whole unit back --------

/** A fault after the unit's LAST statement: reconcile and repair have no result step, so this is the fault point that proves the final statement is atomic with the rest. */
function withTrailingFault<T>(op: PreparedOperation<T>): PreparedOperation<T> {
  return {
    ...op,
    name: `${op.name}+fault-after-last`,
    build: (found, qc) => {
      const built = op.build(found, qc)
      const fault = step(sql`insert into "tasks" ("id", "organization_id") select null, "id" from "organizations"`.compile(qc.db), 'fault')
      return unit({ ...built, steps: [...built.steps, fault] })
    },
  }
}

describe.each(['postgres', 'd1'] as const)('atomicity of auth and directory units on %s', (name) => {
  let e: Engine
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
  })
  const internal = { kind: 'internal', organizationId: null } as const
  const state = async () => Object.fromEntries(await Promise.all(['organizations', 'principals', 'users', 'memberships', 'events'].map(async (t) => [t, await e.rows(t)] as const)))
  const env = { now: NOW, newId: () => uuidv7(NOW) }
  const loneUser = async (subject: string) => {
    const id = uuidv7()
    await e.insert('principals', { id, kind: 'user' })
    await e.insert('users', { id, email: `${subject}@x.test`, auth_provider: 'clerk', auth_subject: subject })
    return id
  }
  const roll = async (op: PreparedOperation<unknown>, identity: Parameters<Engine['runAs']>[0], expectedKind = 'not_null') => {
    const before = await state()
    const err = await settle(e.runAs(identity, op))
    expect(err).toBeInstanceOf(StatementFailed)
    expect((err as StatementFailed).kind).toBe(expectedKind)
    expect(await state()).toEqual(before)
  }

  describe.each(['first-mutation', 'result'] as const)('first sight, a fault after %s', (label) => {
    it('rolls back: no principal, no user', async () => {
      const op = firstSightOperation({ provider: 'clerk', subject: 'user_new', email: 'new@x.test', name: null, emailVerified: false, principalId: uuidv7(), now: NOW })
      await roll(withFault(op, { after: label }), internal)
    })
  })

  describe.each(['first-mutation', 'first-event', 'last'] as const)('reconcile, a fault after %s', (label) => {
    it('rolls back the system principal, the rename and every membership change', async () => {
      await loneUser('user_x')
      const op = reconcileOperation({
        provider: 'clerk',
        externalId: e.authOrgId,
        organization: { name: 'Renamed' },
        members: [{ subject: e.userSubject, role: 'member' }, { subject: 'user_x', role: 'member' }], // re-role u1, create user_x, delete user2
        newOrganizationId: uuidv7(),
        env,
      })
      await roll(label === 'last' ? withTrailingFault(op) : withFault(op, { after: label }), { kind: 'internal', organizationId: e.organizationId })
    })
  })

  describe.each(['first-mutation', 'first-event', 'last'] as const)('repair, a fault after %s', (label) => {
    it('rolls back the system principal, the membership and its event', async () => {
      const userId = await loneUser('user_x')
      const op = repairOperation({ provider: 'clerk', externalId: e.authOrgId, userId, role: 'member', knownOrganizationId: e.organizationId, fetchedName: null, newOrganizationId: uuidv7(), env })
      await roll(label === 'last' ? withTrailingFault(op) : withFault(op, { after: label }), { kind: 'internal', organizationId: e.organizationId })
    })
  })

  it('the API-key stamp is atomic too: a fault after it leaves last_used_at null', async () => {
    const { hash, prefix } = await generateApiKey(() => crypto.getRandomValues(new Uint8Array(32)))
    await e.insert('api_keys', { agent_id: e.agentId, key_hash: hash, prefix })
    const before = await e.rows('api_keys')
    const err = await settle(e.runAs(internal, withFault(apiKeyAuthOperation(hash, NOW), { after: 'first-mutation' })))
    expect(err).toBeInstanceOf(StatementFailed)
    expect(await e.rows('api_keys')).toEqual(before)
  })

  it('bootstrap is atomic: a fault after the organisation leaves nothing behind', async () => {
    const secret = await generateApiKey(() => new Uint8Array(32).fill(3))
    if (name === 'd1') {
      // D1 bootstraps a deployment that has its marker and no organisation row yet.
      await clearD1(e.d1!)
      await seedDeployment(e.d1!, { organizationId: e.organizationId, externalId: e.authOrgId, organization: false })
    }
    const op = bootstrapOperation({
      organizationId: name === 'd1' ? e.organizationId : uuidv7(),
      organizationName: 'Acme',
      link: name === 'd1' ? { provider: e.authProvider, externalId: e.authOrgId } : null,
      email: 'boot@x.test',
      userName: null,
      login: null,
      agentName: 'bot',
      scopes: ['tasks:read'],
      ids: { user: uuidv7(), membership: uuidv7(), agent: uuidv7(), apiKey: uuidv7() },
      secret,
      now: NOW,
    })
    await roll(withFault(op, { after: 'first-mutation' }), internal)
  })
})
