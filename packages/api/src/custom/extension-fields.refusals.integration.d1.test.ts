import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ActionKit, Actor } from '../test/action-kit.js'
import {
  RESOURCES,
  RULES,
  baseBody,
  company,
  every,
  openExtendedKit,
  pathOf,
  resetKit,
  type Resource,
} from '../test/extension-kit.js'

// [[CORE559]] P3, P4 (D8's API half, D20, D21, D22): required fields, a reference's live check and a unique field's refusals on the four built-ins, the same as on a custom object.
let k: ActionKit
let owner: Actor
beforeAll(async () => {
  k = await openExtendedKit(every(RULES))
})
afterAll(() => k.close())
beforeEach(async () => {
  await resetKit(k)
  owner = k.owner
})
const code = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]

describe.each(RESOURCES)('%s', (r: Resource) => {
  const create = async (extra: Record<string, unknown> = {}, n = 1) =>
    k.call(owner, 'POST', pathOf(r), { ...(await baseBody(k, owner, r, n)), req__c: 'x', ...extra })

  describe('a required field with no default (D8)', () => {
    it('is refused on create when missing or null, naming the field', async () => {
      const body = await baseBody(k, owner, r)
      const missing = await k.call(owner, 'POST', pathOf(r), body)
      expect(code(missing)).toEqual([400, 'validation_error'])
      expect(missing.body.error.message).toContain('req__c')
      const nulled = await k.call(owner, 'POST', pathOf(r), { ...body, req__c: null })
      expect(code(nulled)).toEqual([400, 'validation_error'])
      expect(nulled.body.error.message).toContain('req__c')
    })
    it('is refused on update when set to null, and accepted when omitted', async () => {
      const made = await create()
      expect(made.status, JSON.stringify(made.body)).toBe(201)
      const nulled = await k.call(owner, 'PATCH', `${pathOf(r)}/${made.body.id}`, { req__c: null })
      expect(code(nulled)).toEqual([400, 'validation_error'])
      expect(nulled.body.error.message).toContain('req__c')
      const omitted = await k.call(owner, 'PATCH', `${pathOf(r)}/${made.body.id}`, { seq__c: 5 })
      expect(omitted.status).toBe(200)
      expect(omitted.body.req__c).toBe('x')
    })
    it('a row whose value is NULL (as a system writer leaves it) still reads, lists and updates', async () => {
      const made = await create()
      await k.d1.prepare(`update "${r}" set "req__c" = null where id = ?`).bind(made.body.id).run()
      const got = await k.call(owner, 'GET', `${pathOf(r)}/${made.body.id}`)
      expect(got.status).toBe(200)
      expect(got.body.req__c).toBeNull()
      expect((await k.call(owner, 'GET', pathOf(r))).body.data[0].req__c).toBeNull()
      const patched = await k.call(owner, 'PATCH', `${pathOf(r)}/${made.body.id}`, { seq__c: 7 })
      expect(patched.status).toBe(200)
      expect(patched.body.req__c).toBeNull()
    })
  })

  describe('a required field with a default', () => {
    it('is optional on create, takes the default, reads non-null and is refused null on update', async () => {
      const made = await create()
      expect(made.body.lvl__c).toBe('a')
      expect((await create({ lvl__c: 'b' }, 2)).body.lvl__c).toBe('b')
      const nulled = await k.call(owner, 'PATCH', `${pathOf(r)}/${made.body.id}`, { lvl__c: null })
      expect(code(nulled)).toEqual([400, 'validation_error'])
      const [{ notnull }] = ((
        await k.d1.prepare(`select "notnull" from pragma_table_info('${r}') where name = 'lvl__c'`).all()
      ).results ?? []) as Array<{ notnull: number }>
      expect(notnull).toBe(1)
    })
  })

  describe('a reference (D21)', () => {
    it('refuses a deleted or foreign target with 400 invalid_reference, and a live one is stored', async () => {
      const live = await company(k, owner, 'Live', { req__c: 'x' })
      const ok = await create({ co__c: live })
      expect(ok.status, JSON.stringify(ok.body)).toBe(201)
      expect(ok.body.co__c).toBe(live)
      const gone = await company(k, owner, 'Gone', { req__c: 'x' })
      expect((await k.call(owner, 'DELETE', `/api/v1/companies/${gone}`)).status).toBe(204)
      expect(code(await create({ co__c: gone }, 2))).toEqual([400, 'invalid_reference'])
      expect(code(await create({ co__c: '0190b2c4-0000-7000-8000-00000000dead' }, 3))).toEqual([
        400,
        'invalid_reference',
      ])
      expect(code(await k.call(owner, 'PATCH', `${pathOf(r)}/${ok.body.id}`, { co__c: gone }))).toEqual([
        400,
        'invalid_reference',
      ])
    })
    it('a target deleted between the plan and the commit aborts the write as 409 conflict (drift)', async () => {
      const target = await company(k, owner, 'Racing', { req__c: 'x' })
      const body = { ...(await baseBody(k, owner, r)), req__c: 'x', co__c: target }
      k.beforeCommit(async () => {
        await k.d1
          .prepare(`update "companies" set deleted_at = '2026-11-06T10:00:00.000Z' where id = ?`)
          .bind(target)
          .run()
      })
      const res = await k.call(owner, 'POST', pathOf(r), body)
      expect(code(res)).toEqual([409, 'conflict'])
      expect((await k.rows(r, `"co__c" is not null`)).length).toBe(0)
    })
  })

  describe('a unique field (D22)', () => {
    it('refuses a second live row with 409 value_exists naming the first, on create and on update', async () => {
      const first = await create({ code__c: 'A-1', seq__c: 1 })
      expect(first.status, JSON.stringify(first.body)).toBe(201)
      const dup = await create({ code__c: 'A-1' }, 2)
      expect(code(dup)).toEqual([409, 'value_exists'])
      expect(dup.body.error.message).toContain(first.body.id)
      const dupInt = await create({ seq__c: 1 }, 3)
      expect(code(dupInt)).toEqual([409, 'value_exists'])
      const second = await create({ code__c: 'A-2' }, 4)
      const moved = await k.call(owner, 'PATCH', `${pathOf(r)}/${second.body.id}`, { code__c: 'A-1' })
      expect(code(moved)).toEqual([409, 'value_exists'])
      expect(moved.body.error.message).toContain(first.body.id)
      // the record's own value is no conflict, null never collides, and a deleted row frees its value
      expect((await k.call(owner, 'PATCH', `${pathOf(r)}/${first.body.id}`, { code__c: 'A-1' })).status).toBe(200)
      expect((await create({}, 5)).status).toBe(201)
      expect((await create({}, 6)).status).toBe(201)
      expect((await k.call(owner, 'DELETE', `${pathOf(r)}/${first.body.id}`)).status).toBe(204)
      expect((await create({ code__c: 'A-1' }, 7)).status).toBe(201)
    })
    it('the index alone refuses a writer that slipped in between the plan and the commit (409 conflict)', async () => {
      const body = { ...(await baseBody(k, owner, r)), req__c: 'x', code__c: 'RACE' }
      const other = await baseBody(k, owner, r, 2)
      k.beforeCommit(async () => {
        // a live row of the same organisation takes the value after the plan read found none
        const row = await k.call(owner, 'POST', pathOf(r), { ...other, req__c: 'y', code__c: 'RACE' })
        expect(row.status, JSON.stringify(row.body)).toBe(201)
      })
      const res = await k.call(owner, 'POST', pathOf(r), body)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('conflict')
      expect((await k.rows(r, `"code__c" = 'RACE'`)).length).toBe(1)
    })
  })
})
