import { describe, expect, it } from 'vitest'
import { coldStorage } from '../test/storage.js'
import { createApp } from './app.js'

const mk = (version?: string) => createApp({ storage: coldStorage(), version })
const doc = async (app = mk()) => {
  const res = await app.request('/api/v1/openapi.json')
  expect(res.status).toBe(200)
  return (await res.json()) as any
}

describe('GET /api/v1/openapi.json', () => {
  it('is served unauthenticated', async () => {
    const d = await doc()
    expect(d.openapi).toBe('3.1.0')
    expect(d.info.title).toBe('Vault records API')
  })
  it('names operations', async () => {
    const d = await doc()
    expect(d.paths['/api/v1/tasks'].get.operationId).toBe('tasks.list')
    expect(d.paths['/api/v1/tasks'].post.operationId).toBe('tasks.create')
    expect(d.paths['/api/v1/tasks/{id}'].get.operationId).toBe('tasks.get')
    expect(d.paths['/api/v1/tasks/{id}'].patch.operationId).toBe('tasks.update')
    expect(d.paths['/api/v1/tasks/{id}'].delete.operationId).toBe('tasks.delete')
    for (const item of Object.values<any>(d.paths)) {
      for (const o of Object.values<any>(item)) {
        expect(o.summary).toBeTruthy()
        expect(o.security).toEqual([{ bearerAuth: [] }])
      }
    }
  })
  it('describes requests and responses', async () => {
    const d = await doc()
    const body = d.paths['/api/v1/tasks'].post.requestBody.content['application/json'].schema
    expect(Object.keys(body.properties)).toContain('title')
    expect(body.additionalProperties).toBe(false)
    const names = d.paths['/api/v1/tasks'].get.parameters.map((p: any) => p.name)
    expect(names).toEqual(expect.arrayContaining(['after', 'limit', 'status', 'assignee_id']))
    expect(d.paths['/api/v1/tasks/{id}'].delete.responses['204']).toBeDefined()
  })
  it('registers the security scheme', async () => {
    const d = await doc()
    expect(d.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' })
  })
  it('carries the version', async () => {
    expect((await doc(mk('abc123'))).info.version).toBe('abc123')
  })
})
