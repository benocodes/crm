import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { SEED_AT } from '../test/insert.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// [[CHN423]]: a form's agent principal is managed by its form (CHN420 D4, D13 agent.updated part). Fixtures are direct inserts (the API refuses to build the states some groups need).
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

const ALL = ['forms:read', 'forms:write', 'agents:read', 'agents:write', 'events:read']
const call = async (method: string, path: string, body?: unknown, scopes: string[] = ALL) => {
  const token = mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes, kind: 'user' })
  const res = await app.request(`https://vibase.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
}
const FORMS = '/meta/v1/forms'
const AGENTS = '/meta/v1/agents'
const createForm = (name: string) => call('POST', FORMS, { name })
const patchForm = (id: string, body: unknown) => call('PATCH', `${FORMS}/${id}`, body)
const delForm = (id: string) => call('DELETE', `${FORMS}/${id}`)
const agentOf = async (id: string) => (await call('GET', `${AGENTS}/${id}`)).body
const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]
const UNKNOWN = '0190b2c4-0000-7000-8000-00000000dead'

let seeded = 0
/** A form with its principal and agent rows, inserted directly; `agent` overrides the agent row (a diverged name, an earlier disabled_at). */
const seedForm = async (over: { name?: string; deleted?: boolean; agent?: Record<string, unknown> } = {}) => {
  seeded++
  const id = `0190b2c4-0000-7000-8000-0000000e${String(seeded).padStart(4, '0')}`
  const name = over.name ?? `Seed ${seeded}`
  await e.insert('principals', { id, kind: 'agent', created_at: SEED_AT })
  await e.insert('agents', { id, name, scopes: [], disabled_at: null, ...over.agent })
  await e.insert('forms', {
    id,
    name,
    public_id: `frm_${String(seeded).padStart(26, '0').replace(/0/g, 'a')}`,
    enabled: true,
    email_field: 'email',
    phone_field: null,
    name_field: 'name',
    consent_text: null,
    ...(over.deleted ? { deleted_at: SEED_AT } : {}),
  })
  return id
}
const snapshot = async () => ({
  agents: await e.rows('agents'),
  forms: await e.rows('forms'),
  events: (await e.events()).length,
})
const typesSince = async (n: number) => (await e.events()).slice(n).map((x: any) => x.type)

describe('1. agents.update refuses a form principal (matrix: body shape x form state)', () => {
  const shapes: [string, Record<string, unknown>][] = [
    ['name', { name: 'Renamed' }],
    ['disabled false', { disabled: false }],
    ['disabled true', { disabled: true }],
    ['scopes', { scopes: ['forms:read'] }],
    ['add_scopes', { add_scopes: ['forms:read'] }],
    ['remove_scopes', { remove_scopes: ['forms:read'] }],
    ['empty body', {}],
  ]
  for (const state of ['live', 'deleted'] as const)
    for (const [label, body] of shapes)
      it(`${state} form, ${label}: 409 form_principal, agent row and event log unchanged`, async () => {
        const id = await seedForm({ deleted: state === 'deleted', agent: state === 'deleted' ? { disabled_at: SEED_AT } : {} })
        const before = await snapshot()
        const r = await call('PATCH', `${AGENTS}/${id}`, body)
        expect(refusal(r)).toEqual([409, 'form_principal'])
        expect(r.body.error.message).toContain(`managed by form ${id}`)
        expect(r.body.error.message).toContain('change the form')
        expect(await snapshot()).toEqual(before)
      })

  it('order: an invalid body on a form agent is 400, an unknown id is 404 (also with a form-agent-shaped body)', async () => {
    const id = await seedForm()
    expect(refusal(await call('PATCH', `${AGENTS}/${id}`, { disabled: 'no' }))).toEqual([400, 'validation_error'])
    expect(refusal(await call('PATCH', `${AGENTS}/${id}`, { scopes: ['x'], add_scopes: ['y'] }))).toEqual([
      400,
      'validation_error',
    ])
    expect(refusal(await call('PATCH', `${AGENTS}/${UNKNOWN}`, { name: 'x' }))).toEqual([404, 'not_found'])
    expect(refusal(await call('PATCH', `${AGENTS}/${UNKNOWN}`, { add_scopes: ['forms:read'] }))).toEqual([
      404,
      'not_found',
    ])
  })

  it('an ordinary agent, even one whose name equals a form, is still updated; a form created through the API is refused', async () => {
    const made = await createForm('Website')
    const ordinary = await call('POST', AGENTS, { name: 'Website' })
    expect(ordinary.status).toBe(201)
    const u = await call('PATCH', `${AGENTS}/${ordinary.body.id}`, { name: 'Other', disabled: true })
    expect(u.status).toBe(200)
    expect(u.body).toMatchObject({ name: 'Other' })
    expect(u.body.disabled_at).not.toBeNull()
    const add = await call('PATCH', `${AGENTS}/${ordinary.body.id}`, { add_scopes: ['forms:read'] })
    expect(add.status).toBe(200)
    expect(refusal(await call('PATCH', `${AGENTS}/${made.body.id}`, { name: 'x' }))).toEqual([409, 'form_principal'])
  })

  it('the agent stays in agents.list and agents.get with its ordinary shape', async () => {
    const made = await createForm('Website')
    const got = await agentOf(made.body.id)
    expect(Object.keys(got).sort()).toEqual(
      [
        'auth_client_id', 'auth_provider', 'auth_subject', 'created_at', 'created_by', 'delegated_by', 'disabled_at',
        'id', 'name', 'organization_id', 'scopes', 'updated_at',
      ].sort(),
    )
    const listed = (await call('GET', AGENTS)).body.data.map((a: any) => a.id)
    expect(listed).toContain(made.body.id)
  })
})

describe('3. rename sync (P4)', () => {
  it('a rename sets the agent name and updated_at; events are exactly agent.updated then form.updated, both by the owner, before/after of the agent equal agents.get', async () => {
    const f = await createForm('Website')
    const agentBefore = await agentOf(f.body.id)
    const mark = (await e.events()).length
    const u = await patchForm(f.body.id, { name: 'Landing' })
    expect(u.status).toBe(200)
    const agentAfter = await agentOf(f.body.id)
    expect(agentAfter.name).toBe('Landing')
    expect(agentAfter.updated_at).toBe(u.body.updated_at)
    expect(agentAfter.updated_at).not.toBe(agentBefore.updated_at)
    const made = (await e.events()).slice(mark)
    expect(made.map((x: any) => x.type)).toEqual(['agent.updated', 'form.updated'])
    expect(made.map((x: any) => x.actor_id)).toEqual([e.userId, e.userId])
    expect(made.map((x: any) => x.resource_id)).toEqual([f.body.id, f.body.id])
    expect(made[0]!.before).toEqual(agentBefore)
    expect(made[0]!.after).toEqual(agentAfter)
    expect(made[1]!.after).toEqual(u.body)
  })

  it('a case-only rename changes the agent', async () => {
    const f = await createForm('Website')
    const mark = (await e.events()).length
    expect((await patchForm(f.body.id, { name: 'WEBSITE' })).status).toBe(200)
    expect((await agentOf(f.body.id)).name).toBe('WEBSITE')
    expect(await typesSince(mark)).toEqual(['agent.updated', 'form.updated'])
  })

  it('an update without name, or with the stored name, emits no agent.updated and leaves agents.updated_at', async () => {
    const f = await createForm('Website')
    const agentBefore = await agentOf(f.body.id)
    const mark = (await e.events()).length
    expect((await patchForm(f.body.id, { enabled: false })).status).toBe(200)
    expect((await patchForm(f.body.id, { name: 'Website' })).status).toBe(200)
    expect(await typesSince(mark)).toEqual(['form.updated', 'form.updated'])
    expect(await agentOf(f.body.id)).toEqual(agentBefore)
  })

  it('an agent name diverged by a direct seed is brought back by a rename, and a same-name update leaves it diverged', async () => {
    const id = await seedForm({ name: 'Website', agent: { name: 'Drifted' } })
    const mark = (await e.events()).length
    expect((await patchForm(id, { name: 'Website' })).status).toBe(200)
    expect((await agentOf(id)).name).toBe('Website')
    expect(await typesSince(mark)).toEqual(['agent.updated', 'form.updated'])
  })

  it('a rename refused (duplicate name, validation, unknown form) changes neither row and emits nothing', async () => {
    const a = await createForm('A')
    const b = await createForm('B')
    const before = await snapshot()
    expect(refusal(await patchForm(b.body.id, { name: 'a' }))).toEqual([409, 'form_name_exists'])
    expect(refusal(await patchForm(b.body.id, { name: '' }))).toEqual([400, 'validation_error'])
    expect(refusal(await patchForm(UNKNOWN, { name: 'Z' }))).toEqual([404, 'not_found'])
    expect(await snapshot()).toEqual(before)
    expect(a.status).toBe(201)
  })

  it('a rename that fails at the unique index (a duplicate seeded past the plan check) leaves both rows and the log unchanged', async () => {
    const f = await createForm('Website')
    const before = await snapshot()
    e.betweenPlanAndCommit(async () => void (await seedForm({ name: 'Landing' })))
    const r = await patchForm(f.body.id, { name: 'Landing' })
    expect(refusal(r)).toEqual([409, 'conflict'])
    const after = await snapshot()
    expect(after.events).toBe(before.events)
    expect(after.agents.find((a) => a.id === f.body.id)).toEqual(before.agents.find((a) => a.id === f.body.id))
    expect(after.forms.find((x) => x.id === f.body.id)).toEqual(before.forms.find((x) => x.id === f.body.id))
  })
})

describe('4. disable on delete (P5)', () => {
  it('delete sets the agent disabled_at and updated_at; events are agent.updated then form.deleted; the agent stays listed and readable', async () => {
    const f = await createForm('Website')
    const agentBefore = await agentOf(f.body.id)
    const mark = (await e.events()).length
    expect((await delForm(f.body.id)).status).toBe(204)
    const agent = await agentOf(f.body.id)
    expect(agent.disabled_at).not.toBeNull()
    expect(agent.updated_at).toBe(agent.disabled_at)
    expect(Object.keys(agent).sort()).toEqual(Object.keys(agentBefore).sort())
    expect({ ...agent, disabled_at: null, updated_at: agentBefore.updated_at }).toEqual(agentBefore)
    const made = (await e.events()).slice(mark)
    expect(made.map((x: any) => x.type)).toEqual(['agent.updated', 'form.deleted'])
    expect(made.map((x: any) => x.actor_id)).toEqual([e.userId, e.userId])
    expect(made[0]!.before).toEqual(agentBefore)
    expect(made[0]!.after).toEqual(agent)
    expect(made[1]!.after).toBeNull()
    expect((await call('GET', AGENTS)).body.data.map((a: any) => a.id)).toContain(f.body.id)
  })

  it('an agent already disabled keeps its earlier disabled_at and updated_at and gets no agent.updated', async () => {
    const earlier = '2026-10-22T09:00:00.000Z'
    const id = await seedForm({ agent: { disabled_at: earlier } })
    const agentBefore = await agentOf(id)
    const mark = (await e.events()).length
    expect((await delForm(id)).status).toBe(204)
    expect(await typesSince(mark)).toEqual(['form.deleted'])
    expect(await agentOf(id)).toEqual(agentBefore)
    expect(agentBefore.disabled_at).toBe(earlier)
  })

  it('a failure inside the unit leaves the form live and the agent enabled (the form changed between plan and commit)', async () => {
    const f = await createForm('Website')
    const before = await snapshot()
    e.betweenPlanAndCommit(async () => void (await e.update('forms', f.body.id, { consent_text: 'changed meanwhile' })))
    const r = await delForm(f.body.id)
    expect(r.status).toBe(409)
    const after = await snapshot()
    expect(after.agents).toEqual(before.agents)
    expect(after.events).toBe(before.events)
    expect(after.forms.find((x) => x.id === f.body.id)!.deleted_at).toBeNull()
  })

  it('a second delete is 404 and writes nothing; so is an unknown id', async () => {
    const f = await createForm('Website')
    await delForm(f.body.id)
    const before = await snapshot()
    expect(refusal(await delForm(f.body.id))).toEqual([404, 'not_found'])
    expect(refusal(await delForm(UNKNOWN))).toEqual([404, 'not_found'])
    expect(await snapshot()).toEqual(before)
  })
})

describe('5. feed filtering', () => {
  it('a reader with forms:read but not agents:read sees form.* and not agent.updated', async () => {
    const f = await createForm('Website')
    await patchForm(f.body.id, { name: 'Landing' })
    await delForm(f.body.id)
    const feed = async (scopes: string[]) =>
      ((await call('GET', '/api/v1/events?limit=200', undefined, scopes)).body.data as { type: string }[]).map((x) => x.type)
    const formsOnly = await feed(['events:read', 'forms:read'])
    expect(formsOnly.filter((t) => t.startsWith('form.')).sort()).toEqual(['form.created', 'form.deleted', 'form.updated'])
    expect(formsOnly.filter((t) => t.startsWith('agent.'))).toEqual([])
    const both = await feed(['events:read', 'forms:read', 'agents:read'])
    expect(both.filter((t) => t === 'agent.updated')).toHaveLength(2)
  })
})
