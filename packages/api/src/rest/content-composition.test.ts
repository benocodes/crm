import { describe, expect, it } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { coldStorage } from '../test/storage.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { createApp } from './app.js'

const org = uuidv7()
const app = () => createApp({ storage: coldStorage(), userAuthenticator: fakeUserAuthenticator() })
const get = (path: string, scopes: string[]) =>
  app().request(path, { headers: { authorization: `Bearer ${mintTestUserToken({ userId: uuidv7(), organizationId: org, scopes })}` } })
const err = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error
const doc = async () => (await (await createApp({ storage: coldStorage() }).request('/api/v1/openapi.json')).json()) as any

describe('content operations without an object store (D52)', () => {
  it('503 before any unit runs', async () => {
    for (const [path, scope] of [[`/api/v1/messages/${uuidv7()}/content`, 'messages:read'], [`/api/v1/files/${uuidv7()}/content`, 'files:read']] as const) {
      const res = await get(path, [scope])
      expect(res.status).toBe(503)
      expect(await err(res)).toEqual({ code: 'objects_unavailable', message: 'object storage is not configured' })
    }
  })
  it('the scope check comes first', async () => {
    const res = await get(`/api/v1/messages/${uuidv7()}/content`, ['interactions:read'])
    expect(res.status).toBe(403)
    expect((await err(res)).code).toBe('insufficient_scope')
  })
  it('other routes are unaffected', async () => {
    expect((await app().request('/api/v1/openapi.json')).status).toBe(200)
  })
})

describe('OpenAPI', () => {
  it('documents the binary route as application/octet-stream', async () => {
    const d = await doc()
    const op = d.paths['/api/v1/files/{id}/content'].get
    expect(op.operationId).toBe('files.content')
    expect(Object.keys(op.responses['200'].content)).toEqual(['application/octet-stream'])
    expect(op.responses['200'].content['application/octet-stream'].schema).toEqual({ type: 'string', format: 'binary' })
  })
  it('documents the json route', async () => {
    const d = await doc()
    const op = d.paths['/api/v1/messages/{id}/content'].get
    expect(op.operationId).toBe('messages.content')
    expect(Object.keys(op.responses['200'].content['application/json'].schema.properties).sort()).toEqual(['content', 'content_type', 'version'])
  })
})
