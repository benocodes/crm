import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { createApp } from '../rest/app.js'
import { memoryObjectStore, type ObjectStore } from '../objects/store.js'
import { openEngines, type Engine } from '../test/engines.js'
import { foreignTenant } from '../test/identity-kit.js'
import { seedConversation } from '../test/messaging-kit.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { fileBlobKey, messageBodyKey } from './r2-keys.js'

// messages.content and files.content on both engines ([[CORE25]] D32, D33, D52). D1 is the gate; Postgres is reported.
let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

const SCOPES = ['messages:read', 'files:read']

describe.each(['postgres', 'd1'] as const)('content operations on %s', (name) => {
  let e: Engine
  let store: ObjectStore
  let gets: string[]
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    const inner = memoryObjectStore()
    gets = []
    store = { ...inner, get: (k) => (gets.push(k), inner.get(k)) }
  })

  const app = () => createApp({ storage: () => e.binding, userAuthenticator: fakeUserAuthenticator(), objects: store })
  const call = (path: string, over: { scopes?: string[]; kind?: 'user' | 'agent'; userId?: string } = {}) =>
    app().request(path, {
      headers: { authorization: `Bearer ${mintTestUserToken({ userId: over.userId ?? e.userId, organizationId: e.organizationId, scopes: over.scopes ?? SCOPES, kind: over.kind })}` },
    })
  const seed = (opts: Parameters<typeof seedConversation>[1] = {}) => seedConversation((t, r) => e.insert(t, r), opts)
  const err = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error

  it('markdown content', async () => {
    const c = await seed()
    await store.put(messageBodyKey(c.contentKey!, 1), '# Hi\n\nBody')
    const res = await call(`/messages/${c.messageId}/content`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ content_type: 'text/markdown', content: '# Hi\n\nBody', version: 1 })
    expect(Object.keys(body as object).filter((k) => k.includes('key'))).toEqual([])
    // The layout is spelled out, not rebuilt with the helper under test (D23).
    expect(gets).toEqual([`${c.contentKey}/v1/body.md`])
  })

  it('reads the current version', async () => {
    const c = await seed({ version: 2 })
    await store.put(messageBodyKey(c.contentKey!, 1), 'old')
    await store.put(messageBodyKey(c.contentKey!, 2), 'new')
    const res = await call(`/messages/${c.messageId}/content`)
    expect(await res.json()).toEqual({ content_type: 'text/markdown', content: 'new', version: 2 })
  })

  it('accepts an upper-case id', async () => {
    const c = await seed()
    await store.put(messageBodyKey(c.contentKey!, 1), 'x')
    const res = await call(`/messages/${c.messageId.toUpperCase()}/content`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { content: string }).content).toBe('x')
  })

  it('a reaction has no content and the store is never read', async () => {
    const c = await seed({ kind: 'reaction' })
    const res = await call(`/messages/${c.messageId}/content`)
    expect(res.status).toBe(404)
    expect((await err(res)).code).toBe('content_unavailable')
    expect(gets).toEqual([])
  })

  it('a missing object is content_unavailable', async () => {
    const c = await seed()
    const res = await call(`/messages/${c.messageId}/content`)
    expect(res.status).toBe(404)
    expect(await err(res)).toEqual({ code: 'content_unavailable', message: 'no content is stored for this message' })
  })

  it('an unknown or non-UUID message id is not_found and the store is never read', async () => {
    for (const id of [uuidv7(), 'abc']) {
      const res = await call(`/messages/${id}/content`)
      expect(res.status).toBe(404)
      expect(await err(res)).toEqual({ code: 'not_found', message: 'message not found' })
    }
    expect(gets).toEqual([])
  })

  it('file bytes and headers', async () => {
    const c = await seed({ attachments: [{ position: 0, name: 'Jane "CV".pdf', size_bytes: 256 }] })
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    await store.put(fileBlobKey(c.storageKeys[0]!), bytes)
    const res = await call(`/files/${c.fileIds[0]}/content`)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-length')).toBe('256')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Jane _CV_.pdf"; filename*=UTF-8''Jane%20%22CV%22.pdf`)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  it('an unsafe mime type is served as application/octet-stream', async () => {
    const file = await e.insert('files', { name: 'x.html', mime_type: 'text/html; charset=utf-8\r\nx: y', size_bytes: 1, sha256: 'a'.repeat(64), storage_key: `orgs/${e.organizationId}/files/${uuidv7()}` })
    await store.put(fileBlobKey(file.storage_key as string), new Uint8Array([1]))
    const res = await call(`/files/${file.id}/content`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('a missing blob is content_unavailable', async () => {
    const c = await seed({ attachments: 1 })
    const res = await call(`/files/${c.fileIds[0]}/content`)
    expect(res.status).toBe(404)
    expect(await err(res)).toEqual({ code: 'content_unavailable', message: 'no content is stored for this file' })
  })

  it('an unknown file is not_found', async () => {
    const res = await call(`/files/${uuidv7()}/content`)
    expect(res.status).toBe(404)
    expect(await err(res)).toEqual({ code: 'not_found', message: 'file not found' })
  })

  it('splits the scopes (D25)', async () => {
    const c = await seed({ attachments: 1 })
    const only = (scopes: string[], path: string) => call(path, { scopes })
    let res = await only(['interactions:read'], `/messages/${c.messageId}/content`)
    expect(res.status).toBe(403)
    expect(await err(res)).toEqual({ code: 'insufficient_scope', message: 'requires messages:read' })
    res = await only(['interactions:read'], `/files/${c.fileIds[0]}/content`)
    expect(res.status).toBe(403)
    expect((await err(res)).message).toBe('requires files:read')
    res = await only(['messages:read'], `/files/${c.fileIds[0]}/content`)
    expect(res.status).toBe(403)
    expect((await err(res)).message).toBe('requires files:read')
  })

  it('an agent principal can read', async () => {
    const c = await seed()
    await store.put(messageBodyKey(c.contentKey!, 1), 'x')
    const res = await call(`/messages/${c.messageId}/content`, { kind: 'agent', userId: e.agentId })
    expect(res.status).toBe(200)
  })

  it('writes no events', async () => {
    const c = await seed({ attachments: 1 })
    await store.put(messageBodyKey(c.contentKey!, 1), 'x')
    await store.put(fileBlobKey(c.storageKeys[0]!), new Uint8Array([1]))
    const before = (await e.rows('events')).length
    for (const p of [`/messages/${c.messageId}/content`, `/files/${c.fileIds[0]}/content`, `/files/${uuidv7()}/content`, `/messages/abc/content`]) await call(p)
    await call(`/messages/${c.messageId}/content`, { scopes: [] })
    expect((await e.rows('events')).length).toBe(before)
  })

  it.skipIf(name === 'd1')('a foreign organisation is not_found and the store is never read', async () => {
    const f = await foreignTenant(e)
    const c = await seedConversation((t, r) => e.insert(t, { ...r, organization_id: f.organizationId, created_by: f.userId }))
    await store.put(messageBodyKey(c.contentKey!, 1), 'secret')
    const res = await call(`/messages/${c.messageId}/content`)
    expect(res.status).toBe(404)
    expect((await err(res)).code).toBe('not_found')
    expect(gets).toEqual([])
  })
})
