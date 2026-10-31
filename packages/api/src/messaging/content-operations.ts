import { z } from 'zod'
import { defineOperation, readMaybe, selectColumns, unit } from '@vault/storage'
import { ApiError } from '../errors.js'
import { files } from '../resources/files.js'
import { messages } from '../resources/messages.js'
import { safeContentType } from '../rest/binary.js'
import type { BinaryBody, TenantOperation } from '../registry.js'
import { canonicalId } from '../storage/prepare.js'
import { fileBlobKey, messageBodyKey } from './r2-keys.js'

// messages.content and files.content ([[CORE25]] D32, D33, D52). Each is one read unit that returns the hidden object key
// to the object stage only (never into a response or an event); the stage then reads R2 after the unit has finished.

const idParams = z.object({ id: z.uuid() })

interface MessageFound {
  id: string
  kind: string
  content_key: string | null
  version: number | string
}
interface FileFound {
  id: string
  name: string
  mime_type: string
  storage_key: string
}

export const messagesContentOperation: TenantOperation = {
  kind: 'tenant',
  surface: 'api',
  name: 'messages.content',
  summary: "Read a message's markdown content",
  tags: ['messages'],
  method: 'get',
  path: '/messages/{id}/content',
  scope: { resource: 'messages', action: 'read' },
  validation: 'handler',
  request: { params: idParams },
  response: {
    status: 200,
    schema: z.object({ content_type: z.literal('text/markdown'), content: z.string(), version: z.number().int() }),
  },
  prepare: (env, input) => {
    const id = canonicalId(messages, String(input.params.id))
    return defineOperation<MessageFound | null>({
      name: 'messages.content',
      mutates: false,
      reads: (qc) => ({
        row: readMaybe(
          selectColumns(qc, 'messages', ['id', 'kind', 'content_key', 'version'])
            .where('id', '=', id)
            .where('organization_id', '=', env.organizationId),
        ),
      }),
      build: (found) =>
        unit({
          steps: [],
          events: [],
          decode: () => {
            const row = found.maybe('row') as unknown as MessageFound | undefined
            if (!row) throw new ApiError(404, 'not_found', `${messages.eventName} not found`)
            return row
          },
        }),
    })
  },
  objects: async (value, store) => {
    const row = value as MessageFound
    const version = Number(row.version)
    const unavailable = () => new ApiError(404, 'content_unavailable', 'no content is stored for this message')
    if (row.content_key === null) throw unavailable()
    const object = await store.get(messageBodyKey(row.content_key, version))
    if (!object) throw unavailable()
    const content = await new Response(object.body).text()
    return { content_type: 'text/markdown', content, version }
  },
}

export const filesContentOperation: TenantOperation = {
  kind: 'tenant',
  surface: 'api',
  name: 'files.content',
  summary: "Download a file's bytes",
  tags: ['files'],
  method: 'get',
  path: '/files/{id}/content',
  scope: { resource: 'files', action: 'read' },
  validation: 'handler',
  request: { params: idParams },
  output: 'binary',
  response: { status: 200 },
  prepare: (env, input) => {
    const id = canonicalId(files, String(input.params.id))
    return defineOperation<FileFound | null>({
      name: 'files.content',
      mutates: false,
      reads: (qc) => ({
        row: readMaybe(
          selectColumns(qc, 'files', ['id', 'name', 'mime_type', 'storage_key'])
            .where('id', '=', id)
            .where('organization_id', '=', env.organizationId),
        ),
      }),
      build: (found) =>
        unit({
          steps: [],
          events: [],
          decode: () => {
            const row = found.maybe('row') as unknown as FileFound | undefined
            if (!row) throw new ApiError(404, 'not_found', `${files.eventName} not found`)
            return row
          },
        }),
    })
  },
  objects: async (value, store): Promise<BinaryBody> => {
    const row = value as FileFound
    const object = await store.get(fileBlobKey(row.storage_key))
    if (!object) throw new ApiError(404, 'content_unavailable', 'no content is stored for this file')
    return { body: object.body, size: object.size, contentType: safeContentType(row.mime_type), filename: row.name }
  },
}

export const contentOperations = (): TenantOperation[] => [messagesContentOperation, filesContentOperation]
