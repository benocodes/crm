import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// [[CHN420]] D15, D6, D7, D10 (cycle 1): migration 0023's three tables and the constraints each holds whatever writes it.
// The raw inserts are the permitted exception (the schema test proves what the database refuses, which no operation reaches).
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-17T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const PID = (c: string) => `frm_${c.repeat(26)}`

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['G'])
  d1 = local.bindings.G!
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
})
afterAll(async () => {
  await local.dispose()
})

const run = (sqlText: string, ...binds: unknown[]) =>
  d1.batch([d1.prepare(sqlText).bind(...binds)]).then(
    () => null,
    (e: Error) => e.message,
  )
const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return run(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...Object.values(row),
  )
}
const all = async <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as T[]

/** A form's principal and agent rows, then the form row: `forms.id` references `agents (id)`. */
let n = 1000
const fid = (k: number) => `0190b2c4-0000-7000-8000-0000000${String(k).padStart(5, '0')}`
const agent = async (agentId: string) => {
  await seedPrincipal(d1, { id: agentId, kind: 'agent' })
  expect(
    await insert('agents', {
      id: agentId,
      created_at: AT,
      updated_at: AT,
      organization_id: ORG,
      name: 'form agent',
      scopes: '[]',
      created_by: USER,
    }),
  ).toBeNull()
}
const form = (over: Record<string, unknown> = {}) => ({
  id: id(1),
  created_at: AT,
  updated_at: AT,
  organization_id: ORG,
  created_by: USER,
  name: 'Website',
  public_id: PID('a'),
  enabled: 1,
  email_field: 'email',
  phone_field: null,
  name_field: 'name',
  consent_text: null,
  ...over,
})
const fresh = async (over: Record<string, unknown> = {}) => {
  n++
  const formId = fid(n)
  await agent(formId)
  return form({ id: formId, name: `Form ${n}`, public_id: `frm_${String(n).padStart(26, '0')}`, ...over })
}

describe('forms', () => {
  it('creates forms, form_allowed_origins and form_tags', async () => {
    for (const t of ['forms', 'form_allowed_origins', 'form_tags'])
      expect(await all('select name from sqlite_master where type = ? and name = ?', 'table', t), t).toHaveLength(1)
  })

  it('forms.id references agents (id): a form row with no agent row is refused, with one it is accepted', async () => {
    expect(await insert('forms', form({ id: id(90) }))).toMatch(/FOREIGN KEY/)
    await agent(id(1))
    expect(await insert('forms', form())).toBeNull()
  })

  it('the public id is a frm_ prefix and 26 lowercase Crockford base32 characters, and unique over deleted rows too', async () => {
    const bad = async (pid: string) => {
      const row = await fresh({ public_id: pid })
      return insert('forms', row)
    }
    for (const pid of [
      `FRM_${'a'.repeat(26)}`,
      `frm_${'A'.repeat(26)}`,
      `frm_${'a'.repeat(25)}`,
      `frm_${'a'.repeat(27)}`,
      `frm_${'a'.repeat(25)}i`,
      `frm_${'a'.repeat(25)}l`,
      `frm_${'a'.repeat(25)}o`,
      `frm_${'a'.repeat(25)}u`,
      `frm_${'a'.repeat(25)}-`,
      `frm-${'a'.repeat(26)}`,
      'a'.repeat(30),
      '',
    ])
      expect(await bad(pid), pid).toMatch(/CHECK/)
    expect(await bad('frm_0123456789abcdefghjkmnpqrs')).toBeNull()
    expect(await bad('frm_tvwxyz0123456789abcdefghjk')).toBeNull()
    // a deleted form keeps its public id: a new row may not take it
    const gone = await fresh({ public_id: PID('e') })
    expect(await insert('forms', gone)).toBeNull()
    expect(await run('UPDATE forms SET deleted_at = ? WHERE id = ?', AT, gone.id)).toBeNull()
    expect(await insert('forms', await fresh({ public_id: PID('e') }))).toMatch(/UNIQUE/)
    expect(await insert('forms', await fresh({ public_id: PID('f') }))).toBeNull()
  })

  it('the mapping: at least one identity field, no two equal, each field shaped 1 to 64 of A-Za-z0-9_.[]-', async () => {
    const t = async (over: Record<string, unknown>) => insert('forms', await fresh(over))
    expect(await t({ email_field: null, phone_field: null })).toMatch(/CHECK/)
    expect(await t({ email_field: null, phone_field: null, name_field: 'name' })).toMatch(/CHECK/)
    expect(await t({ email_field: 'x', phone_field: 'x' })).toMatch(/CHECK/)
    expect(await t({ email_field: 'x', name_field: 'x' })).toMatch(/CHECK/)
    expect(await t({ email_field: 'y', phone_field: 'x', name_field: 'x' })).toMatch(/CHECK/)
    expect(await t({ email_field: 'has space' })).toMatch(/CHECK/)
    expect(await t({ email_field: '' })).toMatch(/CHECK/)
    expect(await t({ email_field: 'x'.repeat(65) })).toMatch(/CHECK/)
    expect(await t({ email_field: 'ünï' })).toMatch(/CHECK/)
    expect(await t({ phone_field: 'a!' })).toMatch(/CHECK/)
    expect(await t({ name_field: '$n' })).toMatch(/CHECK/)
    expect(await t({ email_field: null, phone_field: 'tel', name_field: null })).toBeNull()
    expect(await t({ email_field: 'contact[email]', phone_field: 'a.b-c_d', name_field: 'x'.repeat(64) })).toBeNull()
    // the same holds on update
    const row = await fresh()
    expect(await insert('forms', row)).toBeNull()
    expect(await run('UPDATE forms SET email_field = NULL WHERE id = ?', row.id)).toMatch(/CHECK/)
    expect(await run('UPDATE forms SET phone_field = email_field WHERE id = ?', row.id)).toMatch(/CHECK/)
  })

  it('consent_text is null or 1 to 2000 characters; enabled is 0 or 1; name is 1 to 200', async () => {
    const t = async (over: Record<string, unknown>) => insert('forms', await fresh(over))
    expect(await t({ consent_text: '' })).toMatch(/CHECK/)
    expect(await t({ consent_text: 'x'.repeat(2001) })).toMatch(/CHECK/)
    expect(await t({ consent_text: 'x'.repeat(2000) })).toBeNull()
    expect(await t({ consent_text: 'x' })).toBeNull()
    expect(await t({ enabled: 2 })).toMatch(/CHECK/)
    expect(await t({ enabled: 0 })).toBeNull()
    expect(await t({ name: '' })).toMatch(/CHECK/)
    expect(await t({ name: 'x'.repeat(201) })).toMatch(/CHECK/)
  })

  it('a live name is unique per organisation ignoring ASCII case; a deleted twin does not count; the id check holds', async () => {
    const a = await fresh({ name: 'Unique Name' })
    expect(await insert('forms', a)).toBeNull()
    expect(await insert('forms', await fresh({ name: 'unique NAME' }))).toMatch(/UNIQUE/)
    // NOCASE folds ASCII only
    expect(await insert('forms', await fresh({ name: 'Éxample' }))).toBeNull()
    expect(await insert('forms', await fresh({ name: 'éxample' }))).toBeNull()
    expect(await run('UPDATE forms SET deleted_at = ? WHERE id = ?', AT, a.id)).toBeNull()
    expect(await insert('forms', await fresh({ name: 'unique name' }))).toBeNull()
    expect(await insert('forms', form({ id: 'not-a-uuid', name: 'z', public_id: PID('g') }))).toMatch(/CHECK/)
  })
})

describe('form_allowed_origins and form_tags (constraints)', () => {
  let f: string
  beforeAll(async () => {
    const row = await fresh({ name: 'Children', public_id: PID('h') })
    f = row.id as string
    expect(await insert('forms', row)).toBeNull()
  })
  const origin = (over: Record<string, unknown> = {}) => ({
    id: id(70),
    organization_id: ORG,
    form_id: f,
    origin: 'https://example.com',
    created_at: AT,
    ...over,
  })
  const tag = (over: Record<string, unknown> = {}) => ({
    id: id(71),
    organization_id: ORG,
    form_id: f,
    tag_id: id(80),
    created_at: AT,
    ...over,
  })

  it('form_allowed_origins: unique per form, composite foreign key, id and timestamp checks', async () => {
    expect(await insert('form_allowed_origins', origin())).toBeNull()
    expect(await insert('form_allowed_origins', origin({ id: id(72) }))).toMatch(/UNIQUE/)
    expect(await insert('form_allowed_origins', origin({ id: id(72), origin: 'https://other.example' }))).toBeNull()
    expect(
      await insert('form_allowed_origins', origin({ id: id(73), form_id: id(99), origin: 'https://x.example' })),
    ).toMatch(/FOREIGN KEY/)
    expect(await insert('form_allowed_origins', origin({ id: 'nope', origin: 'https://y.example' }))).toMatch(/CHECK/)
    expect(await insert('form_allowed_origins', origin({ id: id(74), origin: '', created_at: AT }))).toMatch(/CHECK/)
  })

  it('form_tags: unique per form and tag, composite foreign key to forms, plain foreign key to tags', async () => {
    expect(await insert('form_tags', tag())).toMatch(/FOREIGN KEY/)
    expect(
      await insert('tags', {
        id: id(80),
        created_at: AT,
        updated_at: AT,
        organization_id: ORG,
        name: 'Lead',
        created_by: USER,
      }),
    ).toBeNull()
    expect(await insert('form_tags', tag())).toBeNull()
    expect(await insert('form_tags', tag({ id: id(72) }))).toMatch(/UNIQUE/)
    expect(await insert('form_tags', tag({ id: id(73), form_id: id(99) }))).toMatch(/FOREIGN KEY/)
  })
})
