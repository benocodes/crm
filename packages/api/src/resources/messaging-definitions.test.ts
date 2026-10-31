import { describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
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
    expect(createVaultRegistry().declaredScopes()).toEqual([
      'agents:read', 'agents:write', 'associations:read', 'associations:write', 'companies:read', 'companies:write', 'contacts:read', 'contacts:write', 'files:read',
      'interactions:read', 'members:read', 'messages:read', 'tasks:read', 'tasks:write',
    ])
  })

  it('generates exactly the planned routes among the new names, and no update for any of the six', () => {
    const ops = createVaultRegistry().operations()
    const names = ops.map((o) => o.name)
    const fresh = names.filter((n) => /^(threads|messages|interactions|files|contact_files|company_files)\./.test(n)).sort()
    expect(fresh).toEqual(
      [
        'threads.list', 'threads.get', 'messages.list', 'messages.get', 'messages.content', 'interactions.list', 'interactions.get', 'files.list', 'files.get', 'files.content',
        'contact_files.list', 'contact_files.get', 'contact_files.create', 'contact_files.delete',
        'company_files.list', 'company_files.get', 'company_files.create', 'company_files.delete',
      ].sort(),
    )
    expect(ops.filter((o) => fresh.includes(o.name) && o.method === 'patch')).toEqual([])
    expect(createVaultRegistry().get('contact_files.list')).toMatchObject({ path: '/contact-files' })
    expect(createVaultRegistry().get('company_files.get')).toMatchObject({ path: '/company-files/{id}' })
  })

  it('the content operations (CORE58)', () => {
    const reg = createVaultRegistry()
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

  it('list query schemas carry the column filters and the join filters', () => {
    const reg = createVaultRegistry()
    const keys = (name: string) => Object.keys(((reg.get(name) as { request: { query: { shape: object } } }).request.query as { shape: object }).shape).sort()
    expect(keys('messages.list')).toEqual(['after', 'limit', 'thread_id', 'channel', 'kind', 'external_id', 'in_reply_to'].sort())
    expect(keys('interactions.list')).toEqual(['after', 'limit', 'kind', 'channel', 'direction', 'thread_id', 'message_id', 'identity_id', 'contact_id'].sort())
  })

  it('the link body is strict', () => {
    expect(() => parseInput(contactFiles.create!, { contact_id: uuid, file_id: uuid, x: 1 })).toThrow()
    expect(parseInput(contactFiles.create!, { contact_id: uuid, file_id: uuid })).toEqual({ contact_id: uuid, file_id: uuid })
  })
})
