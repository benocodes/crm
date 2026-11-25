import { describe, expect, it } from 'vitest'
import { ownerOnlyClientPrivileges, type ClientPrivileges } from './auth.js'

// [[CORE577]] D10, P1, P3: the hook Better Auth calls before every OAuth client action. Owner only, whatever the action, and closed when the vault cannot say.
type Action = Parameters<ClientPrivileges>[0]['action']
// A record over the library's action union: a new action in a library upgrade fails the typecheck here until it is listed (and so tested).
const ALL: Record<Action, true> = {
  create: true,
  read: true,
  list: true,
  update: true,
  delete: true,
  rotate: true,
  'configure-client-credentials-scopes': true,
}
const ACTIONS = Object.keys(ALL) as Action[]
const call = (hook: ClientPrivileges, action: Action, subject: string | null) =>
  hook({
    headers: new Headers(),
    action,
    ...(subject === null ? {} : { user: { id: subject } as never, session: { userId: subject } as never }),
  })
const roles: Record<string, 'owner' | 'member' | null> = { 'u-owner': 'owner', 'u-member': 'member', 'u-gone': null }
const hook = ownerOnlyClientPrivileges(async (s) => roles[s] === 'owner')

describe('the client privileges hook (D10, P1, P3)', () => {
  it.each(ACTIONS)('%s: an owner is allowed', async (action) => {
    expect(await call(hook, action, 'u-owner')).toBe(true)
  })
  it.each(ACTIONS)('%s: a member, a subject with no membership and a missing session are refused', async (action) => {
    expect(await call(hook, action, 'u-member')).toBe(false)
    expect(await call(hook, action, 'u-gone')).toBe(false)
    expect(await call(hook, action, 'u-unknown')).toBe(false)
    expect(await call(hook, action, null)).toBe(false)
  })
  it.each(ACTIONS)('%s: a lookup that throws refuses (fail closed)', async (action) => {
    const broken = ownerOnlyClientPrivileges(async () => {
      throw new Error('D1 is down')
    })
    expect(await call(broken, action, 'u-owner')).toBe(false)
  })
  it.each(ACTIONS)('%s: no lookup configured refuses', async (action) => {
    expect(await call(ownerOnlyClientPrivileges(undefined), action, 'u-owner')).toBe(false)
  })
})
