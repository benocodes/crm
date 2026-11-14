import { describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { parseInput, scopeResourceOf } from './define.js'
import { companyFiles } from './company-files.js'
import { contactFiles } from './contact-files.js'
import { files } from './files.js'
import { interactions } from './interactions.js'
import { messages } from './messages.js'
import { threads } from './threads.js'

const six = [threads, messages, interactions, files, contactFiles, companyFiles]
const uuid = '0190b2c4-0000-7000-8000-000000000001'

describe('messaging definitions (CORE25 C1)', () => {
  it('scope resources', () => {
    expect(six.map(scopeResourceOf)).toEqual(['messages', 'messages', 'interactions', 'files', 'contacts', 'companies'])
  })

  it('declared scopes', () => {
    expect(createVibaseRegistry().declaredScopes()).toEqual([
      'action_requests:read', 'agents:read', 'agents:write', 'associations:read', 'associations:request_approval', 'associations:write', 'companies:read', 'companies:request_approval', 'companies:write', 'connections:read', 'connections:write',
      'contacts:read', 'contacts:request_approval', 'contacts:write', 'deals:read', 'deals:request_approval', 'deals:write', 'events:read', 'files:read', 'interactions:read', 'invitations:read', 'invitations:write', 'members:read', 'members:write', 'messages:read', 'messages:request_approval', 'messages:write', 'notes:read', 'notes:request_approval', 'notes:write',
      'pipelines:read', 'pipelines:request_approval', 'pipelines:write', 'schema:read', 'tags:read', 'tags:request_approval', 'tags:write', 'tasks:read', 'tasks:request_approval', 'tasks:write', 'webhooks:read', 'webhooks:write',
    ])
  })

  it('generates exactly the planned routes among the new names, and no update for any of the six', () => {
    const ops = createVibaseRegistry().operations()
    const names = ops.map((o) => o.name)
    const fresh = names.filter((n) => /^(threads|messages|interactions|files|contact_files|company_files)\./.test(n)).sort()
    expect(fresh).toEqual(
      [
        'threads.list', 'threads.get', 'messages.list', 'messages.get', 'messages.content', 'messages.send', 'interactions.list', 'interactions.get', 'files.list', 'files.get', 'files.content',
        'contact_files.list', 'contact_files.get', 'contact_files.create', 'contact_files.delete',
        'company_files.list', 'company_files.get', 'company_files.create', 'company_files.delete',
      ].sort(),
    )
    expect(ops.filter((o) => fresh.includes(o.name) && o.method === 'patch')).toEqual([])
    expect(createVibaseRegistry().get('contact_files.list')).toMatchObject({ path: '/contact-files' })
    expect(createVibaseRegistry().get('company_files.get')).toMatchObject({ path: '/company-files/{id}' })
  })

  it('the content operations (CORE58)', () => {
    const reg = createVibaseRegistry()
    expect(reg.get('files.content')).toMatchObject({ output: 'binary', method: 'get', path: '/files/{id}/content', scope: { resource: 'files', action: 'read' } })
    expect(reg.get('messages.content')).toMatchObject({ method: 'get', path: '/messages/{id}/content', scope: { resource: 'messages', action: 'read' } })
  })

  it('hidden columns are absent from every record', () => {
    for (const def of six) {
      const keys = Object.keys(def.record.shape)
      expect(keys.length).toBeGreaterThan(0)
      for (const hidden of ['content_key', 'storage_key', 'fetch_metadata', 'fetch_error', 'organization_id']) expect(keys, `${def.name} ${hidden}`).not.toContain(hidden)
    }
  })

  it('list query schemas carry the column filters and the custom filters', () => {
    const reg = createVibaseRegistry()
    const keys = (name: string) => Object.keys(((reg.get(name) as { request: { query: { shape: object } } }).request.query as { shape: object }).shape).sort()
    // CORE201: every filterable column of the record is a filter now, so the old parameters are a subset.
    expect(keys('messages.list')).toEqual(expect.arrayContaining(['after', 'limit', 'sort', 'order', 'thread_id', 'channel', 'kind', 'external_id', 'in_reply_to', 'occurred_at']))
    expect(keys('interactions.list')).toEqual(expect.arrayContaining(['after', 'limit', 'sort', 'order', 'kind', 'channel', 'direction', 'thread_id', 'message_id', 'identity_id', 'contact_id']))
  })

  it('the link body is strict', () => {
    expect(() => parseInput(contactFiles.create!, { contact_id: uuid, file_id: uuid, x: 1 })).toThrow()
    expect(parseInput(contactFiles.create!, { contact_id: uuid, file_id: uuid })).toEqual({ contact_id: uuid, file_id: uuid })
  })
})
