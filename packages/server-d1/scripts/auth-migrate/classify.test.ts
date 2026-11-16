import { describe, expect, it } from 'vitest'
import { classify } from './classify.js'
import { exportClerkUsers } from './clerk-export.js'
import { CLERK_SECRET, fakeClerk, ids, standardClerk, standardWorld } from './test-kit.js'
import type { Snapshot } from './types.js'

const counter = () => {
  let n = 0
  return () => `new-id-${++n}`
}
async function snapshot(): Promise<Snapshot> {
  const clerk_users = await exportClerkUsers({ secretKey: CLERK_SECRET, fetch: fakeClerk(standardClerk(), 3).fetch })
  return { clerk_users, ...standardWorld() }
}

// [[OPS365]] group 3: the classification matrix. Agent kind x action, and humans x match.
describe('classifying the agents (D6)', () => {
  it('api_key -> keep; agent_account -> relink to its Clerk user\'s new id; delegated -> disable with its scopes; none of the three is disabled yet', async () => {
    const plan = classify(await snapshot(), counter())
    const by = (n: number) => plan.agents.find((a) => a.id === ids.A(n))!
    expect(by(1)).toMatchObject({ kind: 'api_key', action: 'keep', new_auth_user_id: null, scopes: null })
    expect(by(2)).toMatchObject({ kind: 'agent_account', action: 'relink', new_auth_user_id: 'new-id-4', scopes: null })
    expect(by(3)).toMatchObject({ kind: 'delegated', action: 'disable', scopes: ['contacts:read', 'notes:write'] })
  })

  it('an already-disabled agent is keep whatever its kind, with the reason recorded', async () => {
    const plan = await snapshot().then((s) => classify(s, counter()))
    for (const [n, kind] of [[4, 'api_key'], [5, 'agent_account'], [6, 'delegated']] as const) {
      const a = plan.agents.find((x) => x.id === ids.A(n))!
      expect(a, `agent ${n}`).toMatchObject({ kind, action: 'keep', new_auth_user_id: null })
      expect(a.reason).toMatch(/already disabled/)
    }
  })

  it('an agent account whose Clerk user is gone, or is not an agent, has nothing to relink to: disable, with the reason', async () => {
    const plan = await snapshot().then((s) => classify(s, counter()))
    const gone = plan.agents.find((a) => a.id === ids.A(7))!
    const member = plan.agents.find((a) => a.id === ids.A(8))!
    expect(gone).toMatchObject({ kind: 'agent_account', action: 'disable', new_auth_user_id: null })
    expect(gone.reason).toMatch(/no Clerk user/)
    expect(member).toMatchObject({ kind: 'agent_account', action: 'disable', new_auth_user_id: null })
    expect(member.reason).toMatch(/not an agent/)
  })

  it('every agent is classified, once, in the vault\'s order', async () => {
    const plan = await snapshot().then((s) => classify(s, counter()))
    expect(plan.agents.map((a) => a.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(ids.A))
  })
})

describe('classifying the humans (P4)', () => {
  it('matched by provider clerk and subject: migrate, with the role, the live membership and a new id', async () => {
    const plan = await snapshot().then((s) => classify(s, counter()))
    const by = (n: number) => plan.people.find((p) => p.user_id === ids.U(n))!
    expect(by(1)).toMatchObject({
      email: 'a@example.test',
      old_provider: 'clerk',
      old_subject: 'user_scrubbeda',
      action: 'migrate',
      role: 'owner',
      role_raw: 'owner',
      membership: { id: ids.U(101), role: 'owner' },
      new_auth_user_id: 'new-id-1',
    })
    expect(by(2)).toMatchObject({ action: 'migrate', role: 'member', membership: { id: ids.U(102), role: 'member' }, new_auth_user_id: 'new-id-2' })
  })

  it('a missing Clerk role gets what the adapter gives today: no workspace role (it refuses sign-in)', async () => {
    const plan = await snapshot().then((s) => classify(s, counter()))
    expect(plan.people.find((p) => p.user_id === ids.U(3))).toMatchObject({ action: 'migrate', role: null, role_raw: null, membership: null })
  })

  it('a vault user with no Clerk match is listed with action none: no id, and a deleted membership is not live', async () => {
    const plan = await snapshot().then((s) => classify(s, counter()))
    for (const n of [4, 5]) {
      const p = plan.people.find((x) => x.user_id === ids.U(n))!
      expect(p, `user ${n}`).toMatchObject({ action: 'none', new_auth_user_id: null, role: null, membership: null })
      expect(p.reason).toBeTruthy()
    }
  })

  it('a Clerk user no vault row points at is listed with action none; one an agent account points at is not', async () => {
    const plan = await snapshot().then((s) => classify(s, counter()))
    expect(plan.clerk_only).toEqual([{ clerk_user_id: 'user_scrubbede', email: 'e@example.test', role_raw: 'member', action: 'none' }])
  })

  it('the new ids are unique and one per migrated person or relinked agent', async () => {
    const plan = await snapshot().then((s) => classify(s, counter()))
    const all = [...plan.people.map((p) => p.new_auth_user_id), ...plan.agents.map((a) => a.new_auth_user_id)].filter((x) => x !== null)
    expect(all).toEqual(['new-id-1', 'new-id-2', 'new-id-3', 'new-id-4'])
  })
})

describe('the empty state (rule 3)', () => {
  it('zero Clerk users, zero vault rows: a valid plan with empty lists', () => {
    expect(classify({ clerk_users: [], users: [], agents: [], memberships: [] }, counter())).toEqual({ people: [], clerk_only: [], agents: [] })
  })
  it('vault users with zero Clerk users: every one is none', () => {
    const plan = classify({ clerk_users: [], users: standardWorld().users, agents: [], memberships: [] }, counter())
    expect(plan.people).toHaveLength(5)
    expect(plan.people.every((p) => p.action === 'none')).toBe(true)
  })
})
