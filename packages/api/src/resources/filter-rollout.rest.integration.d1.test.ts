import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { d1Backend } from '../test/d1-backend.js'

// [[CORE201]] on the D1 app over REST: the column filter grammar on lists other than deals (rollout, compatibility, collation) and tag by name on
// companies, contacts and tasks.
const FULL = [
  'companies:read', 'companies:write', 'contacts:read', 'contacts:write', 'tasks:read', 'tasks:write', 'tags:read', 'tags:write', 'associations:read', 'associations:write',
  'pipelines:read', 'pipelines:write', 'files:read',
]
let s: ContractSession
let t: ContractTenant
beforeAll(async () => {
  s = await d1Backend().open(createVaultRegistry())
})
afterAll(async () => {
  await s.close()
})
beforeEach(async () => {
  t = (await s.reset()).a
})
const call = async (scopes: string[], method: string, path: string, body?: unknown) => {
  const res = await s.call(t, 'agent', scopes, method, path, body)
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) }
}
const must = async (method: string, path: string, body?: unknown, scopes = FULL) => {
  const r = await call(scopes, method, path, body)
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300)
  return r.body
}
const labelOf = (d: any) => (d.name ?? d.title ?? d.value ?? d.domain) as string
const list = async (path: string, query: string, scopes = FULL) => {
  const r = await call(scopes, 'GET', `${path}?${query}`)
  expect(r.status, `${path}?${query} ${JSON.stringify(r.body)}`).toBe(200)
  return (r.body.data as any[]).map(labelOf).sort()
}
const refused = async (path: string, query: string, scopes = FULL) => call(scopes, 'GET', `${path}?${query}`)

describe('an operator expression on a list other than deals (D10)', () => {
  it('tasks: comparisons, null tests, patterns and negation return exactly the expected rows', async () => {
    await must('POST', '/api/v1/tasks', { title: 'Call Acme', due_at: '2026-11-05T09:00:00Z' })
    await must('POST', '/api/v1/tasks', { title: 'Send quote', due_at: '2026-12-20T09:00:00Z' })
    await must('POST', '/api/v1/tasks', { title: 'send Invoice' })
    const done = await must('POST', '/api/v1/tasks', { title: 'Archive' })
    await must('PATCH', `/api/v1/tasks/${done.id}`, { status: 'done' })
    const q = (query: string) => list('/api/v1/tasks', query)
    expect(await q('due_at=lt.2026-12-01')).toEqual(['Call Acme'])
    expect(await q('due_at=gte.2026-11-05')).toEqual(['Call Acme', 'Send quote'])
    expect(await q('due_at=is.null')).toEqual(['Archive', 'send Invoice'])
    expect(await q('due_at=not.is.null')).toEqual(['Call Acme', 'Send quote'])
    expect(await q('title=ilike.send*')).toEqual(['Send quote', 'send Invoice'])
    expect(await q('title=like.send*')).toEqual(['send Invoice'])
    expect(await q('title=in.(Archive,Call Acme)')).toEqual(['Archive', 'Call Acme'])
    expect(await q('status=neq.done')).toEqual(['Call Acme', 'Send quote', 'send Invoice'])
    expect(await q('status=done')).toEqual(['Archive'])
    expect(await q('status=done&title=Archive')).toEqual(['Archive'])
    expect(await q('status=not.eq.open&due_at=is.null')).toEqual(['Archive'])
  })
  it('an operator that the kind does not offer is a 400 naming the filter and the available operators', async () => {
    const r = await refused('/api/v1/tasks', 'due_at=like.2026*')
    expect(r.status).toBe(400)
    expect(r.body.error.message).toContain('filter due_at: like is not available for timestamp')
  })
})

describe('compatibility: every bare call keeps its meaning (D10)', () => {
  it('companies?domain: a bare domain is normalised as before, the escape reaches a literal that looks like an operator, the bare one is a 400', async () => {
    await must('POST', '/api/v1/companies', { name: 'Acme', domain: 'example.com' })
    await must('POST', '/api/v1/companies', { name: 'Shortener', domain: 'is.gd' })
    expect(await list('/api/v1/companies', 'domain=example.com')).toEqual(['Acme'])
    expect(await list('/api/v1/companies', 'domain=EXAMPLE.com')).toEqual(['Acme'])
    expect(await list('/api/v1/companies', 'domain=eq.is.gd')).toEqual(['Shortener'])
    expect(await list('/api/v1/companies', 'domain=in.(is.gd,Example.com)')).toEqual(['Acme', 'Shortener'])
    const r = await refused('/api/v1/companies', 'domain=is.gd')
    expect(r.status).toBe(400)
    expect(r.body.error.message).toContain('filter domain')
  })
  it('files?sha256 is still lower-cased; an invalid digest is still a 400', async () => {
    await s.insert(t, 'files', { name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 1, sha256: 'ab'.repeat(32), storage_key: 'files/a' })
    await s.insert(t, 'files', { name: 'b.pdf', mime_type: 'application/pdf', size_bytes: 1, sha256: 'cd'.repeat(32), storage_key: 'files/b' })
    expect(await list('/api/v1/files', `sha256=${'AB'.repeat(32)}`)).toEqual(['a.pdf'])
    expect(await list('/api/v1/files', `sha256=eq.${'AB'.repeat(32)}`)).toEqual(['a.pdf'])
    expect(await list('/api/v1/files', `sha256=neq.${'AB'.repeat(32)}`)).toEqual(['b.pdf'])
    expect((await refused('/api/v1/files', 'sha256=nope')).status).toBe(400)
  })
  it('identities: kind and value together as before, value alone and an invalid value are 400s, and operators work on value once kind is given', async () => {
    const c = await must('POST', '/api/v1/contacts', { name: 'Ada' })
    await must('POST', '/api/v1/identities', { contact_id: c.id, kind: 'email', value: 'ada@example.com' })
    await must('POST', '/api/v1/identities', { contact_id: c.id, kind: 'email', value: 'lovelace@example.com' })
    await must('POST', '/api/v1/identities', { contact_id: c.id, kind: 'phone', value: '+14155550101' })
    expect(await list('/api/v1/identities', 'kind=email&value=ADA@Example.com')).toEqual(['ada@example.com'])
    expect(await list('/api/v1/identities', 'kind=email&value=eq.ADA@Example.com')).toEqual(['ada@example.com'])
    expect(await list('/api/v1/identities', 'kind=email')).toEqual(['ada@example.com', 'lovelace@example.com'])
    expect(await list('/api/v1/identities', 'kind=email&value=in.(Ada@example.com,LOVELACE@example.com)')).toEqual(['ada@example.com', 'lovelace@example.com'])
    expect(await list('/api/v1/identities', 'kind=email&value=ilike.*love*')).toEqual(['lovelace@example.com'])
    expect(await list('/api/v1/identities', 'own=false&kind=phone')).toEqual(['+14155550101'])
    const noKind = await refused('/api/v1/identities', 'value=ada@example.com')
    expect(noKind.status).toBe(400)
    expect(noKind.body.error.message).toContain('filter value requires kind')
    expect((await refused('/api/v1/identities', 'kind=phone&value=abc')).status).toBe(400)
  })
  it('identities: an operator expression on kind is a 400 for value, because its normaliser needs one kind', async () => {
    const r = await refused('/api/v1/identities', 'kind=in.(email,phone)&value=ada@example.com')
    expect(r.status).toBe(400)
    expect(r.body.error.message).toContain('filter value requires kind')
  })
  it('an enum option still refuses a bad value with a 400 naming the filter, and a UUID option refuses a non-UUID', async () => {
    const r = await refused('/api/v1/tasks', 'status=bogus')
    expect(r.status).toBe(400)
    expect(r.body.error.message).toContain('filter status')
    const r2 = await refused('/api/v1/tasks', 'status=in.(open,bogus)')
    expect(r2.status).toBe(400)
    const r3 = await refused('/api/v1/tasks', 'assignee_id=nope')
    expect(r3.status).toBe(400)
    expect(r3.body.error.message).toContain('filter assignee_id')
    expect(await list('/api/v1/tasks', 'status=open')).toEqual([])
  })
  it('the generated parameters are grammar strings: a UUID filter is no longer format uuid, and free-text descriptions state the eq. escape', async () => {
    const doc = (await (await s.call(t, 'agent', FULL, 'GET', '/api/v1/openapi.json')).json()) as any
    const params = (path: string) => Object.fromEntries((doc.paths[path].get.parameters as any[]).map((p) => [p.name, p]))
    const tasks = params('/api/v1/tasks')
    expect(tasks.assignee_id.schema.type).toBe('string')
    expect(tasks.assignee_id.schema.format).toBeUndefined()
    expect(tasks.tag_id.schema.format).toBe('uuid')
    expect(params('/api/v1/companies').domain.description).toContain('domain=eq.')
    expect(params('/api/v1/messages').external_id.description).toContain('external_id=eq.')
  })
})

describe('collation of text filters (D18)', () => {
  it('tags?name and pipelines?name match a differently-cased row, as the live-name uniqueness does; deals?name does not', async () => {
    await must('POST', '/api/v1/tags', { name: 'consultancy' })
    await must('POST', '/api/v1/tags', { name: 'Partner' })
    const p = await must('POST', '/meta/v1/pipelines', { name: 'Sales' })
    await must('POST', '/meta/v1/pipelines', { name: 'Renewals' })
    expect(await list('/api/v1/tags', 'name=eq.CONSULTANCY')).toEqual(['consultancy'])
    expect(await list('/api/v1/tags', 'name=CONSULTANCY')).toEqual(['consultancy'])
    expect(await list('/api/v1/tags', 'name=in.(PARTNER,nothing)')).toEqual(['Partner'])
    expect(await list('/api/v1/tags', 'name=neq.CONSULTANCY')).toEqual(['Partner'])
    expect(await list('/meta/v1/pipelines', 'name=in.(SALES,renewals)')).toEqual(['Renewals', 'Sales'])
    const stage = await must('POST', '/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'Open', kind: 'open', position: 1 })
    await must('POST', '/api/v1/deals', { name: 'Acme pilot', stage_id: stage.id }, [...FULL, 'deals:write'])
    expect(await list('/api/v1/deals', 'name=eq.Acme pilot', [...FULL, 'deals:read'])).toEqual(['Acme pilot'])
    expect(await list('/api/v1/deals', 'name=eq.ACME PILOT', [...FULL, 'deals:read'])).toEqual([])
  })
  it('like stays case-sensitive and ilike folds, on a NOCASE column too', async () => {
    await must('POST', '/api/v1/tags', { name: 'consultancy' })
    expect(await list('/api/v1/tags', 'name=like.Consult*')).toEqual([])
    expect(await list('/api/v1/tags', 'name=like.consult*')).toEqual(['consultancy'])
    expect(await list('/api/v1/tags', 'name=ilike.CONSULT*')).toEqual(['consultancy'])
  })
})

describe.each([
  { list: 'companies', path: '/api/v1/companies', scope: 'companies', body: (n: string) => ({ name: n }), column: 'name' },
  { list: 'contacts', path: '/api/v1/contacts', scope: 'contacts', body: (n: string) => ({ name: n }), column: 'name' },
  { list: 'tasks', path: '/api/v1/tasks', scope: 'tasks', body: (n: string) => ({ title: n }), column: 'title' },
])('tag by name on $list (D7)', ({ list: kind, path, scope, body, column }) => {
  const tagged = async () => {
    const tag = await must('POST', '/api/v1/tags', { name: 'consultancy' })
    const a = await must('POST', path, body('Alpha'))
    const b = await must('POST', path, body('Beta'))
    await must('POST', path, body('Gamma'))
    const link = async (row: { id: string }, tagId = tag.id) => (await must('POST', '/api/v1/associations', { a_type: kind, a_id: row.id, b_type: 'tags', b_id: tagId })) as { id: string }
    const edgeA = await link(a)
    await link(b)
    return { tag, a, b, edgeA, link }
  }
  const q = (query: string, scopes = FULL) => list(path, query, scopes)
  it('keeps rows linked to the live tag of exactly that name (trimmed); tag_id still works', async () => {
    const { tag } = await tagged()
    expect(await q('tag=consultancy')).toEqual(['Alpha', 'Beta'])
    expect(await q('tag=%20consultancy%20')).toEqual(['Alpha', 'Beta'])
    expect(await q(`tag_id=${tag.id}`)).toEqual(['Alpha', 'Beta'])
  })
  it('a differently-cased name, a prefix and an unknown name give an empty page', async () => {
    await tagged()
    expect(await q('tag=Consultancy')).toEqual([])
    expect(await q('tag=consult')).toEqual([])
    expect(await q('tag=no-such-tag')).toEqual([])
  })
  it('a deleted tag and a removed association do not match', async () => {
    const { tag, edgeA, b } = await tagged()
    await must('DELETE', `/api/v1/associations/${edgeA.id}`)
    expect(await q('tag=consultancy')).toEqual(['Beta'])
    const ghost = await s.insert(t, 'tags', { name: 'ghost', deleted_at: '2026-11-02T00:00:00.000Z' })
    await s.insert(t, 'associations', { a_type: kind, a_id: b.id, b_type: 'tags', b_id: ghost.id })
    expect(await q('tag=ghost')).toEqual([])
    expect((await call(FULL, 'DELETE', `/api/v1/tags/${tag.id}`)).status).toBe(204)
    expect(await q('tag=consultancy')).toEqual([])
  })
  it('needs tags:read and associations:read: 403 insufficient_scope naming the scope', async () => {
    await tagged()
    for (const missing of ['tags:read', 'associations:read']) {
      const r = await refused(path, 'tag=consultancy', FULL.filter((x) => x !== missing))
      expect(r.status, missing).toBe(403)
      expect(r.body.error.code).toBe('insufficient_scope')
      expect(r.body.error.message).toContain(missing)
    }
    // without the tag filter the same caller still lists
    expect((await refused(path, '', FULL.filter((x) => x !== 'tags:read'))).status).toBe(200)
    expect(scope).toBeTruthy()
  })
  it('ANDs with a column filter and with the grammar on another column', async () => {
    await tagged()
    expect(await q(`tag=consultancy&${column}=Beta`)).toEqual(['Beta'])
    expect(await q(`tag=consultancy&${column}=not.eq.Beta`)).toEqual(['Alpha'])
    expect(await q(`tag=consultancy&${column}=Gamma`)).toEqual([])
  })
  it('an empty tag name is a 400', async () => {
    const r = await refused(path, 'tag=%20')
    expect(r.status).toBe(400)
  })
})
