import { ScopeSet } from '@vault/api'
export const org = '01900000-0000-7000-8000-000000000001'
export const actor = '01900000-0000-7000-8000-000000000002'
export const task = '01900000-0000-7000-8000-000000000003'
export const ctx = { organizationId:org, actor:{id:actor,kind:'user' as const}, scopes:ScopeSet.parse(['tasks:write','contacts:write']) }
let counter = 100
export const prep = () => ({operationId:`01900000-0000-7000-8000-${(++counter).toString().padStart(12,'0')}`, now:'2026-10-21T10:00:00.000Z', nextId:()=>`01900000-0000-7000-8000-${(++counter).toString().padStart(12,'0')}`})
