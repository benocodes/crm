import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SCOPE_POLICY, SCOPE_DESCRIPTIONS, scopesForRole } from '../auth/roles.js'
import { normalizeAgentScopes } from '../resources/agents.js'
import { createVibaseRegistry } from '../operations.js'
import { proposalMeta } from '../proposal.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { coldStorage } from '../test/storage.js'
import { SEED_AT } from '../test/insert.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// [[CHN420]] cycle 1: the forms resource over its scalar fields (the lists are in forms-origins-tags.integration.d1.test.ts, CHN424) and the principal created with each form (D3, D6, D7, D10, D11 scalar part, D12, D13 part).
// Fixtures are direct inserts (setup bypasses the code under test); the form's principal is a `principals` row, an `agents` row and a `forms` row sharing one id.
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  app = createApp({ storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})

const BOTH = ['forms:read', 'forms:write']
type Who = 'owner' | 'agent'
type Opts = { who?: Who; scopes?: string[] }
const call = async (method: string, path: string, body?: unknown, opts: Opts = {}) => {
  const who = opts.who ?? 'owner'
  const token = mintTestUserToken({
    userId: who === 'agent' ? e.agentId : e.userId,
    organizationId: e.organizationId,
    scopes: opts.scopes ?? BOTH,
    kind: who === 'agent' ? 'agent' : 'user',
  })
  const res = await app.request(`https://vibase.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
}
const PATH = '/meta/v1/forms'
const create = (body: unknown, opts: Opts = {}) => call('POST', PATH, body, opts)
const patch = (id: string, body: unknown, opts: Opts = {}) => call('PATCH', `${PATH}/${id}`, body, opts)
const get = (id: string, opts: Opts = {}) => call('GET', `${PATH}/${id}`, undefined, opts)
const del = (id: string, opts: Opts = {}) => call('DELETE', `${PATH}/${id}`, undefined, opts)
const list = (query = '', opts: Opts = {}) => call('GET', `${PATH}${query ? `?${query}` : ''}`, undefined, opts)
const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]
const events = async (prefix = 'form.') => (await e.events()).filter((x: any) => String(x.type).startsWith(prefix))
const UNKNOWN = '0190b2c4-0000-7000-8000-00000000dead'
const PUBLIC_ID = /^frm_[0-9a-hjkmnp-tv-z]{26}$/

let seeded = 0
/** A form as stored, with its principal and agent rows (what `forms.create` leaves), inserted directly. */
const seedForm = async (over: Record<string, unknown> = {}) => {
  seeded++
  const id = (over.id as string | undefined) ?? `0190b2c4-0000-7000-8000-0000000f${String(seeded).padStart(4, '0')}`
  await e.insert('principals', { id, kind: 'agent', created_at: SEED_AT })
  await e.insert('agents', {
    id,
    name: (over.name as string | undefined) ?? `Seed ${seeded}`,
    scopes: [],
    disabled_at: null,
  })
  return e.insert('forms', {
    id,
    name: `Seed ${seeded}`,
    public_id: `frm_${String(seeded).padStart(26, '0').replace(/0/g, 'a')}`,
    enabled: true,
    email_field: 'email',
    phone_field: null,
    name_field: 'name',
    consent_text: null,
    ...over,
  })
}
const counts = async () => ({
  principals: (await e.rows('principals')).length,
  agents: (await e.rows('agents')).length,
  forms: (await e.rows('forms')).length,
  events: (await e.events()).length,
})

describe('create unit (D3, D13)', () => {
  it('leaves one principals row, one agents row, one forms row sharing the id, then agent.created and form.created, each by the owner', async () => {
    const before = await counts()
    const r = await create({ name: 'Website' })
    expect(r.status).toBe(201)
    const after = await counts()
    expect(after.principals).toBe(before.principals + 1)
    expect(after.agents).toBe(before.agents + 1)
    expect(after.forms).toBe(1)
    const id = r.body.id as string
    const principal = (await e.rows('principals')).find((p) => p.id === id)
    expect(principal?.kind).toBe('agent')
    const agent = (await e.rows('agents')).find((a) => a.id === id)!
    expect(agent).toMatchObject({
      id,
      organization_id: e.organizationId,
      name: 'Website',
      scopes: [],
      disabled_at: null,
      created_by: e.userId,
      auth_provider: null,
      auth_subject: null,
      auth_client_id: null,
      delegated_by: null,
    })
    const form = (await e.rows('forms'))[0]!
    expect(form).toMatchObject({ id, name: 'Website', created_by: e.userId, deleted_at: null })
    const made = (await e.events()).slice(before.events)
    expect(made.map((x: any) => x.type)).toEqual(['agent.created', 'form.created'])
    expect(made.map((x: any) => x.actor_id)).toEqual([e.userId, e.userId])
    expect(made.map((x: any) => x.resource_id)).toEqual([id, id])
    expect(made.map((x: any) => x.resource_type)).toEqual(['agent', 'form'])
    expect(made[0]!.before).toBeNull()
    expect(made[0]!.after).toMatchObject({ id, name: 'Website', scopes: [], disabled_at: null, created_by: e.userId })
    expect(made[1]!.before).toBeNull()
    expect(made[1]!.after).toEqual(r.body)
  })

  it('answers the agents.get of the same id: the form principal is an ordinary, scopeless agent row', async () => {
    const r = await create({ name: 'Website' })
    const a = await call('GET', `/meta/v1/agents/${r.body.id}`, undefined, { scopes: ['agents:read'] })
    expect(a.status).toBe(200)
    expect(a.body).toMatchObject({ id: r.body.id, name: 'Website', scopes: [], disabled_at: null })
  })

  it('a failure later in the unit (a live duplicate name that reaches the index) leaves no principal, agent, form or event', async () => {
    const before = await counts()
    e.betweenPlanAndCommit(async () => void (await seedForm({ name: 'Raced' })))
    const r = await create({ name: 'Raced' })
    expect(refusal(r)).toEqual([409, 'conflict'])
    const after = await counts()
    // the seeded twin is the only addition: one principal, one agent, one form, and its direct insert wrote no event
    expect(after).toEqual({
      principals: before.principals + 1,
      agents: before.agents + 1,
      forms: 1,
      events: before.events,
    })
  })
})

describe('public id (D6, P5)', () => {
  it('matches the minted shape, differs per form, and never changes on update', async () => {
    const a = await create({ name: 'A' })
    const b = await create({ name: 'B' })
    expect(a.body.public_id).toMatch(PUBLIC_ID)
    expect(b.body.public_id).toMatch(PUBLIC_ID)
    expect(a.body.public_id).not.toBe(b.body.public_id)
    const u = await patch(a.body.id, { name: 'A renamed', enabled: false })
    expect(u.status).toBe(200)
    expect(u.body.public_id).toBe(a.body.public_id)
    expect((await get(a.body.id)).body.public_id).toBe(a.body.public_id)
  })

  it('public_id (or id) in a create or update body is 400 validation_error, and nothing is written', async () => {
    const a = await create({ name: 'A' })
    const mark = await counts()
    for (const body of [
      { name: 'X', public_id: 'frm_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { name: 'X', id: UNKNOWN },
    ])
      expect(refusal(await create(body))).toEqual([400, 'validation_error'])
    for (const body of [{ public_id: 'frm_aaaaaaaaaaaaaaaaaaaaaaaaaa' }, { id: UNKNOWN }])
      expect(refusal(await patch(a.body.id, body))).toEqual([400, 'validation_error'])
    expect(await counts()).toEqual(mark)
  })

  it('the mint spreads 128 random bits over the 26 characters (a fixed fill would not)', async () => {
    const r = await create({ name: 'Mint' })
    expect(new Set((r.body.public_id as string).slice(4)).size).toBeGreaterThan(5)
  })
})

describe('validation matrix (D7, D10, D11, P1, P4)', () => {
  const bad = async (body: unknown, needle?: RegExp) => {
    const res = await create(body)
    expect(refusal(res), JSON.stringify(body).slice(0, 80)).toEqual([400, 'validation_error'])
    if (needle) expect(res.body.error.message).toMatch(needle)
    return res
  }

  it('defaults on create: enabled, email and name mapped, phone and consent null', async () => {
    const r = await create({ name: 'Website' })
    expect(r.body).toMatchObject({
      name: 'Website',
      enabled: true,
      email_field: 'email',
      phone_field: null,
      name_field: 'name',
      consent_text: null,
      challenge: 'none',
      created_by: e.userId,
      organization_id: e.organizationId,
    })
    expect(Object.keys(r.body).sort()).toEqual(
      [
        'allowed_origins',
        'challenge',
        'consent_text',
        'created_at',
        'created_by',
        'email_field',
        'enabled',
        'id',
        'name',
        'name_field',
        'organization_id',
        'phone_field',
        'public_id',
        'tag_ids',
        'updated_at',
      ].sort(),
    )
  })

  it("challenge: a new form defaults to 'none', 'turnstile' is accepted, anything else is refused, and an update switches it both ways", async () => {
    const open = await create({ name: 'Open' })
    expect(open.body.challenge).toBe('none')
    const guarded = await create({ name: 'Guarded', challenge: 'turnstile' })
    expect(guarded.body.challenge).toBe('turnstile')
    await bad({ name: 'C', challenge: 'captcha' })
    await bad({ name: 'C', challenge: null })
    expect((await patch(open.body.id, { challenge: 'turnstile' })).body.challenge).toBe('turnstile')
    expect((await patch(open.body.id, { challenge: 'none' })).body.challenge).toBe('none')
    expect(refusal(await patch(open.body.id, { challenge: 'captcha' }))).toEqual([400, 'validation_error'])
  })

  it('field shape: contact[email] and dots are accepted; a space, an empty string or 65 characters are refused', async () => {
    expect((await create({ name: 'A', email_field: 'contact[email]', phone_field: 'a.b-c_d' })).status).toBe(201)
    await bad({ name: 'B', email_field: 'has space' })
    await bad({ name: 'B', email_field: '' })
    await bad({ name: 'B', email_field: 'x'.repeat(65) })
    expect((await create({ name: 'C', email_field: 'x'.repeat(64) })).status).toBe(201)
    await bad({ name: 'B', name_field: 'bad/char' })
  })

  it('at least one identity field: both null is refused on create, and an update that nulls the last one is refused (merged result)', async () => {
    await bad({ name: 'A', email_field: null, phone_field: null }, /email_field|phone_field/)
    const a = await create({ name: 'A', email_field: 'email', phone_field: null })
    expect(refusal(await patch(a.body.id, { email_field: null }))).toEqual([400, 'validation_error'])
    expect((await get(a.body.id)).body.email_field).toBe('email')
    // nulling one while the other stays is fine
    const b = await create({ name: 'B', email_field: 'email', phone_field: 'tel' })
    expect((await patch(b.body.id, { email_field: null })).body).toMatchObject({
      email_field: null,
      phone_field: 'tel',
    })
    // a phone-only form is valid, and nulling the email of a phone-only default is refused
    expect(refusal(await patch(b.body.id, { phone_field: null }))).toEqual([400, 'validation_error'])
  })

  it('no two fields may be equal, on create and on the merged result of an update', async () => {
    await bad({ name: 'A', email_field: 'x', phone_field: 'x' })
    await bad({ name: 'A', email_field: 'x', phone_field: 'y', name_field: 'x' })
    const a = await create({ name: 'A' })
    expect(refusal(await patch(a.body.id, { name_field: 'email' }))).toEqual([400, 'validation_error'])
    expect(refusal(await patch(a.body.id, { phone_field: 'name' }))).toEqual([400, 'validation_error'])
    expect((await patch(a.body.id, { phone_field: 'tel' })).status).toBe(200)
  })

  it('consent_text: empty and 2001 characters refused, 2000 accepted, null accepted and clears', async () => {
    await bad({ name: 'A', consent_text: '' })
    await bad({ name: 'A', consent_text: 'x'.repeat(2001) })
    const ok = await create({ name: 'A', consent_text: 'x'.repeat(2000) })
    expect(ok.status).toBe(201)
    expect(ok.body.consent_text).toHaveLength(2000)
    expect((await patch(ok.body.id, { consent_text: null })).body.consent_text).toBeNull()
    expect(refusal(await patch(ok.body.id, { consent_text: '' }))).toEqual([400, 'validation_error'])
  })

  it('name is trimmed; empty, blank and 201 characters are refused; an unknown field is refused', async () => {
    expect((await create({ name: '  Site  ' })).body.name).toBe('Site')
    await bad({ name: '' })
    await bad({ name: '   ' })
    await bad({ name: 'x'.repeat(201) })
    expect((await create({ name: 'y'.repeat(200) })).status).toBe(201)
    await bad({})
    await bad({ name: 'A', colour: 'red' })
  })

  it('a live duplicate name is 409 form_name_exists (ASCII case-insensitive, naming the holder); after its holder is deleted the name is free; renaming to a taken name is refused, to its own case is fine', async () => {
    const first = await create({ name: 'Website' })
    const mark = await counts()
    const dup = await create({ name: 'website' })
    expect(refusal(dup)).toEqual([409, 'form_name_exists'])
    expect(dup.body.error.message).toContain(first.body.id)
    expect(refusal(await create({ name: ' WEBSITE ' }))).toEqual([409, 'form_name_exists'])
    expect(await counts()).toEqual(mark)
    const other = await create({ name: 'Other' })
    expect(refusal(await patch(other.body.id, { name: 'WebSite' }))).toEqual([409, 'form_name_exists'])
    expect((await patch(first.body.id, { name: 'WEBSITE' })).status).toBe(200)
    expect((await del(first.body.id)).status).toBe(204)
    const again = await create({ name: 'Website' })
    expect(again.status).toBe(201)
    expect(again.body.id).not.toBe(first.body.id)
  })

  it('NOCASE folds ASCII only: the plan check matches it, so names differing only in a non-ASCII case are distinct', async () => {
    expect((await create({ name: 'Été' })).status).toBe(201)
    expect((await create({ name: 'été' })).status).toBe(201)
    expect(refusal(await create({ name: 'été' }))).toEqual([409, 'form_name_exists'])
    expect(refusal(await create({ name: 'ÉTÉ' }))).not.toEqual([409, 'form_name_exists'])
  })

  it('an empty PATCH is refused', async () => {
    const a = await create({ name: 'A' })
    expect(refusal(await patch(a.body.id, {}))).toEqual([400, 'validation_error'])
  })

  it('update of an unknown form is 404 after the body validates', async () => {
    expect(refusal(await patch(UNKNOWN, { enabled: false }))).toEqual([404, 'not_found'])
    expect(refusal(await patch(UNKNOWN, { enabled: 'no' }))).toEqual([400, 'validation_error'])
  })
})

describe('access (D12)', () => {
  it('a member (read only) lists and gets but cannot create, update or delete', async () => {
    const f = await seedForm()
    const read = { scopes: ['forms:read'] }
    expect((await list('', read)).status).toBe(200)
    expect((await get(f.id as string, read)).status).toBe(200)
    for (const r of [
      await create({ name: 'X' }, read),
      await patch(f.id as string, { enabled: false }, read),
      await del(f.id as string, read),
    ])
      expect(refusal(r)).toEqual([403, 'insufficient_scope'])
    expect(refusal(await list('', { scopes: [] }))).toEqual([403, 'insufficient_scope'])
    expect(await events()).toEqual([])
  })

  it('an agent granted forms:read lists; forms:write is not grantable to an agent', async () => {
    await seedForm()
    const asAgent = await list('', { who: 'agent', scopes: ['forms:read'] })
    expect(asAgent.status).toBe(200)
    expect(asAgent.body.data).toHaveLength(1)
    expect(() => normalizeAgentScopes(['forms:read'])).not.toThrow()
    expect(() => normalizeAgentScopes(['forms:write'])).toThrow(/not grantable/)
  })

  it('a token of an agent actor that carries forms:write is 403 user_required on create, update and delete', async () => {
    const f = await seedForm()
    const mark = await counts()
    expect(refusal(await create({ name: 'X' }, { who: 'agent' }))).toEqual([403, 'user_required'])
    expect(refusal(await patch(f.id as string, { enabled: false }, { who: 'agent' }))).toEqual([403, 'user_required'])
    expect(refusal(await del(f.id as string, { who: 'agent' }))).toEqual([403, 'user_required'])
    // before the body is read: an invalid body from an agent is still user_required
    expect(refusal(await create({ nope: 1 }, { who: 'agent' }))).toEqual([403, 'user_required'])
    expect(await counts()).toEqual(mark)
  })

  it('is not proposable: the registry marks the writes ineligible and an action request naming one is refused', async () => {
    const reg = createVibaseRegistry()
    for (const name of ['forms.create', 'forms.update', 'forms.delete']) {
      const decl = reg.get(name)
      expect(decl, name).toBeDefined()
      expect(proposalMeta(decl!).eligible, name).toBe(false)
    }
    const res = await call(
      'POST',
      '/api/v1/action-requests',
      { operation: 'forms.create', arguments: { name: 'X' }, reason: 'x' },
      { scopes: [...BOTH, 'action_requests:read'] },
    )
    expect(refusal(res)).toEqual([400, 'operation_not_proposable'])
  })

  it('SCOPE_POLICY, the role mirror and the descriptions carry both scopes', () => {
    expect(SCOPE_POLICY['forms:read']).toEqual({ member: true, agentGrantable: true })
    expect(SCOPE_POLICY['forms:write']).toEqual({ member: false, agentGrantable: false })
    expect(SCOPE_POLICY['forms:request_approval']).toBeUndefined()
    const declared = createVibaseRegistry().declaredScopes()
    expect(declared).toContain('forms:read')
    expect(declared).toContain('forms:write')
    expect(declared).not.toContain('forms:request_approval')
    const member = scopesForRole('member', declared).toStrings()
    expect(member).toContain('forms:read')
    expect(member).not.toContain('forms:write')
    expect(scopesForRole('owner', declared).toStrings()).toEqual(expect.arrayContaining(BOTH))
    expect(SCOPE_DESCRIPTIONS['forms:read']).toBeTruthy()
    expect(SCOPE_DESCRIPTIONS['forms:write']).toBeTruthy()
  })
})

describe('resource semantics and events (D11, D13)', () => {
  it('get and list return the record; filters by enabled and public_id; sorts by name and created_at', async () => {
    const a = await create({ name: 'Bravo' })
    const b = await create({ name: 'alpha', enabled: false })
    expect((await get(a.body.id)).body).toEqual(a.body)
    const names = async (q: string) => (await list(q)).body.data.map((r: any) => r.name) as string[]
    expect(await names('enabled=false')).toEqual(['alpha'])
    expect(await names('enabled=true')).toEqual(['Bravo'])
    expect(await names(`public_id=${b.body.public_id}`)).toEqual(['alpha'])
    expect(await names('public_id=frm_nothing')).toEqual([])
    expect(await names('sort=name&order=asc')).toEqual(['Bravo', 'alpha'])
    expect(await names('sort=name&order=desc')).toEqual(['alpha', 'Bravo'])
    expect(await names('sort=created_at&order=desc')).toEqual(['alpha', 'Bravo'])
    expect(refusal(await list('enabled=maybe'))).toEqual([400, 'validation_error'])
  })

  it('form.updated is emitted once per accepted update, even for a no-op, with the full before and after', async () => {
    const a = await create({ name: 'A' })
    const mark = (await events()).length
    const u = await patch(a.body.id, { name: 'A' })
    expect(u.status).toBe(200)
    const ups = (await events('form.updated')).slice(0)
    expect(ups).toHaveLength(1)
    expect(await events()).toHaveLength(mark + 1)
    expect(ups[0]!.before).toEqual(a.body)
    expect(ups[0]!.after).toEqual(u.body)
    expect(ups[0]!.actor_id).toBe(e.userId)
    const v = await patch(a.body.id, { consent_text: 'We store your answer.' })
    expect(v.body.consent_text).toBe('We store your answer.')
    expect(await events('form.updated')).toHaveLength(2)
    // refusals write nothing
    await patch(a.body.id, { name: '' })
    await patch(a.body.id, {})
    expect(await events('form.updated')).toHaveLength(2)
  })

  it('delete is soft: form.deleted carries the record, deleted_at is set, the row is kept, then get is 404 and list omits it', async () => {
    const a = await create({ name: 'A' })
    expect((await del(a.body.id)).status).toBe(204)
    const gone = await events('form.deleted')
    expect(gone).toHaveLength(1)
    expect(gone[0]!.before).toEqual(a.body)
    expect(gone[0]!.after).toBeNull()
    const row = (await e.rows('forms')).find((x) => x.id === a.body.id)
    expect(row?.deleted_at).not.toBeNull()
    expect(refusal(await get(a.body.id))).toEqual([404, 'not_found'])
    expect((await list()).body.data).toEqual([])
    expect(refusal(await del(a.body.id))).toEqual([404, 'not_found'])
    expect(refusal(await del(UNKNOWN))).toEqual([404, 'not_found'])
  })

  it('on the feed, forms:read shows the form events and its absence hides them', async () => {
    const a = await create({ name: 'A' })
    await patch(a.body.id, { enabled: false })
    await del(a.body.id)
    const feed = async (scopes: string[]) =>
      ((await call('GET', '/api/v1/events?limit=200', undefined, { scopes })).body.data as { type: string }[])
        .map((x) => x.type)
        .filter((t) => t.startsWith('form.'))
        .sort()
    expect(await feed(['events:read', 'forms:read'])).toEqual(['form.created', 'form.deleted', 'form.updated'])
    expect(await feed(['events:read', 'tags:read'])).toEqual([])
  })
})

describe('surfaces', () => {
  it('OpenAPI lists the five operations with their examples and the strict create body', async () => {
    const meta = (await (await app.request('/meta/v1/openapi.json')).json()) as any
    const col = meta.paths['/meta/v1/forms']
    const mem = meta.paths['/meta/v1/forms/{id}']
    expect(Object.keys(col).sort()).toEqual(['get', 'post'])
    expect(Object.keys(mem).sort()).toEqual(['delete', 'get', 'patch'])
    const schema = col.post.requestBody.content['application/json'].schema
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        'allowed_origins',
        'challenge',
        'consent_text',
        'email_field',
        'enabled',
        'name',
        'name_field',
        'phone_field',
        'tag_ids',
      ].sort(),
    )
    expect(schema.additionalProperties).toBe(false)
    for (const op of [col.get, col.post, mem.get, mem.patch, mem.delete])
      expect(op.description, op.operationId).toMatch(/Example: vibase forms /)
  })

  it('the MCP tools exist and answer as REST does for the same actor', async () => {
    const rpc = async (who: Who, method: string, params: unknown = {}) => {
      const token = mintTestUserToken({
        userId: who === 'agent' ? e.agentId : e.userId,
        organizationId: e.organizationId,
        scopes: BOTH,
        kind: who === 'agent' ? 'agent' : 'user',
      })
      return (await (
        await app.request('/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
      ).json()) as any
    }
    const tools = (await rpc('owner', 'tools/list')).result.tools.map((t: any) => t.name)
    for (const name of ['forms_list', 'forms_get', 'forms_create', 'forms_update', 'forms_delete'])
      expect(tools).toContain(name)
    const made = await rpc('owner', 'tools/call', { name: 'forms_create', arguments: { name: 'Mcp form' } })
    expect(made.result.isError, JSON.stringify(made)).not.toBe(true)
    const refused = await rpc('agent', 'tools/call', { name: 'forms_create', arguments: { name: 'Nope' } })
    expect(refused.result.isError).toBe(true)
    expect(JSON.stringify(refused)).toContain('user_required')
  })

  it('answers 501 not_implemented on a binding that is not D1, before any unit runs', async () => {
    const cold = createApp({ storage: coldStorage(), userAuthenticator: fakeUserAuthenticator() })
    const token = mintTestUserToken({
      userId: '0190b2c4-0000-7000-8000-000000000001',
      organizationId: '0190b2c4-0000-7000-8000-0000000000a1',
      scopes: BOTH,
      kind: 'user',
    })
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    for (const [method, path, body] of [
      ['GET', PATH, undefined],
      ['GET', `${PATH}/${UNKNOWN}`, undefined],
      ['POST', PATH, { name: 'X' }],
      ['PATCH', `${PATH}/${UNKNOWN}`, { enabled: false }],
      ['DELETE', `${PATH}/${UNKNOWN}`, undefined],
    ] as const) {
      const res = await cold.request(path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      expect([res.status, ((await res.json()) as any).error.code], `${method} ${path}`).toEqual([
        501,
        'not_implemented',
      ])
    }
  })
})
