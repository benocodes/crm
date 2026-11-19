import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clerkUser, mintClerkToken } from '@vibase/api/test/clerk'
import { bootstrapD1, clerkKit, composeD1Worker, openWorkerD1, type ClerkKit, type WorkerD1 } from '../../test/kit.js'
import { createApi } from '../session/api.js'
import { buildAgentsView } from './view-model.js'

// [[UI459]] group 6 (D3, D5, D6): the page's API client and view model over the REAL composed Worker on D1, as the owner and as a member.
let w: WorkerD1
let ck: ClerkKit
let worker: ReturnType<typeof composeD1Worker>
const tokens: Record<string, string> = {}

beforeAll(async () => {
  w = await openWorkerD1()
  ck = await clerkKit()
})
afterAll(() => w.dispose())

const send = (who: 'owner' | 'member', input: string, init?: RequestInit) =>
  worker.fetch(
    new Request(input, {
      ...init,
      headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    }),
    { waitUntil: () => {} } as never,
  )
const callerApi = (who: 'owner' | 'member') =>
  createApi({
    origin: 'https://vibase.test',
    getToken: async () => tokens[who]!,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      worker.fetch(new Request(input as string, init), { waitUntil: () => {} } as never)) as typeof fetch,
  })
const post = async (path: string, body: unknown) => {
  const res = await send('owner', `https://vibase.test${path}`, { method: 'POST', body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as any }
}

let formId: string
let scopedId: string
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  worker = composeD1Worker({ ...ck.env, DB: w.d1 } as never, { fetch: ck.fetch })
  await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: ck.issuer.issuer })
  for (const [who, sub, role] of [
    ['owner', 'user_ag_owner', 'owner'],
    ['member', 'user_ag_member', 'member'],
  ] as const) {
    tokens[who] = await mintClerkToken(ck.issuer, { sub, extra: { vibase_role: role } })
    ck.profiles.set(sub, clerkUser({ id: sub, email: `${who}@vibase.test`, role }))
  }
  const agent = await post('/meta/v1/agents', { name: 'real-scoped', scopes: ['contacts:read', 'tasks:read'] })
  expect(agent.status).toBe(201)
  scopedId = agent.body.id
  expect((await post('/meta/v1/agents', { name: 'Real form', scopes: ['tasks:read'] })).status).toBe(201)
  const form = await post('/meta/v1/forms', { name: 'Real form' })
  expect(form.status).toBe(201)
  formId = form.body.id
})

describe('agents() and forms() read every page as both', () => {
  it.each(['owner', 'member'] as const)('%s reads agents and forms', async (who) => {
    const api = callerApi(who)
    const agents = await api.agents()
    expect(agents.status).toBe(200)
    expect(agents.body!.map((a) => a.id)).toEqual(expect.arrayContaining([scopedId, formId]))
    const forms = await api.forms()
    expect(forms.status).toBe(200)
    expect(forms.body!.map((f) => f.id)).toEqual([formId])
    expect(forms.body![0]!.name).toBe('Real form')
  })

  it('follows next_cursor across pages', async () => {
    for (let i = 0; i < 3; i++) expect((await post('/meta/v1/forms', { name: `F${i}` })).status).toBe(201)
    let pages = 0
    const api = createApi({
      origin: 'https://vibase.test',
      getToken: async () => tokens.owner!,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.pathname === '/meta/v1/forms') {
          pages++
          url.searchParams.set('limit', '2')
        }
        return worker.fetch(new Request(url, init), { waitUntil: () => {} } as never)
      }) as typeof fetch,
    })
    const forms = await api.forms()
    expect(forms.body).toHaveLength(4)
    expect(pages).toBeGreaterThan(1)
  })
})

describe('setDisabled', () => {
  it('the owner disables then enables: 200 with disabled_at set and then cleared', async () => {
    const api = callerApi('owner')
    const off = await api.setDisabled(scopedId, true)
    expect(off.status).toBe(200)
    expect(off.body!.disabled_at).toEqual(expect.any(String))
    const on = await api.setDisabled(scopedId, false)
    expect(on.status).toBe(200)
    expect(on.body!.disabled_at).toBeNull()
  })
  it('a member is refused 403', async () => {
    const r = await callerApi('member').setDisabled(scopedId, true)
    expect(r.status).toBe(403)
  })
  it('a form agent answers 409 form_principal', async () => {
    const r = await callerApi('owner').setDisabled(formId, true)
    expect(r.status).toBe(409)
    expect(r.code).toBe('form_principal')
  })
})

describe('the view model over real responses', () => {
  it('marks the form agent by the form id and offers no toggle on it; the owner may toggle the other', async () => {
    const api = callerApi('owner')
    const me = (await api.me()).body!
    const agents = (await api.agents()).body!
    const forms = (await api.forms()).body!
    const view = buildAgentsView({
      scopes: me.active_organization!.scopes,
      meId: me.principal.id,
      agents,
      forms: new Map(forms.map((f) => [f.id, f.name])),
      formatDate: (iso) => iso.slice(0, 10),
    })
    const form = view.rows.find((r) => r.id === formId)!
    expect(form.formManaged).toBe(true)
    expect(form.action).toBeNull()
    expect(form.meta[0]).toBe('Website form Real form')
    // an ordinary agent that shares the form's name is not the form's agent
    const lookalike = view.rows.find((r) => r.name === 'Real form' && r.id !== formId)!
    expect(lookalike.formManaged).toBe(false)
    expect(lookalike.action).toBe('disable')
    const scoped = view.rows.find((r) => r.id === scopedId)!
    expect(scoped.formManaged).toBe(false)
    expect(scoped.action).toBe('disable')
    expect(scoped.meta[1]).toBe('Permissions: contacts (read), tasks (read)')
  })
  it('the member sees the same rows with no actions', async () => {
    const api = callerApi('member')
    const me = (await api.me()).body!
    const view = buildAgentsView({
      scopes: me.active_organization!.scopes,
      meId: me.principal.id,
      agents: (await api.agents()).body!,
      forms: new Map((await api.forms()).body!.map((f) => [f.id, f.name])),
      formatDate: (iso) => iso.slice(0, 10),
    })
    expect(view.access).toBe(true)
    expect(view.canWrite).toBe(false)
    expect(view.rows.length).toBeGreaterThan(1)
    expect(view.rows.every((r) => r.action === null && r.grantCommand === null)).toBe(true)
  })
})
