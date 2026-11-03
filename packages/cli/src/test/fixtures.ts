// Fixture OpenAPI documents in the shape the vault serves ([[API32]]): zod-openapi 3.1, absolute paths, no `servers`.
import type { JsonSchema } from '../types.js'

const uuid: JsonSchema = { type: 'string', format: 'uuid' }
const q = (name: string, schema: JsonSchema, required = false) => ({ name, in: 'query', required, schema })
const p = (name: string) => ({ name, in: 'path', required: true, schema: uuid })
const json = (schema: JsonSchema) => ({ 'application/json': { schema } })
const ok = (schema: JsonSchema, status = '200') => ({ [status]: { description: 'Success', content: json(schema) } })
const widget: JsonSchema = { type: 'object', properties: { id: uuid, name: { type: ['string', 'null'] } }, required: ['id', 'name'] }
const page: JsonSchema = { type: 'object', properties: { data: { type: 'array', items: widget }, next_cursor: { type: ['string', 'null'], format: 'uuid' } }, required: ['data', 'next_cursor'] }
const bodyProps: Record<string, JsonSchema> = {
  name: { type: ['string', 'null'], maxLength: 500 },
  size: { type: 'integer' },
  ratio: { type: 'number' },
  enabled: { type: 'boolean' },
  meta: { type: 'object', additionalProperties: true },
  tags: { type: 'array', items: { type: 'string' } },
  due_at: { type: ['string', 'null'] },
  // Reserved name: reachable only through --data.
  data: { type: 'string' },
  // Same name as a query parameter of the operation: the query parameter wins.
  color: { type: 'string' },
}

export const apiDoc = (): any => ({
  openapi: '3.1.0',
  info: { title: 'fixture', version: '1' },
  components: { schemas: { Widget: widget } },
  paths: {
    '/api/v1/widgets': {
      get: {
        operationId: 'widgets.list',
        summary: 'List widgets',
        parameters: [q('after', uuid), q('limit', { type: 'integer', minimum: 1, maximum: 200 }), q('color', { type: 'string', enum: ['red', 'blue'] }), q('active', { type: 'boolean' })],
        responses: ok(page),
      },
      post: {
        operationId: 'widgets.create',
        summary: 'Create a widget',
        requestBody: { required: true, content: json({ type: 'object', properties: bodyProps, additionalProperties: false }) },
        responses: ok({ $ref: '#/components/schemas/Widget' }, '201'),
      },
    },
    '/api/v1/widgets/{widget_id}/parts/{part_id}': {
      get: { operationId: 'parts.get', summary: 'Get a part', parameters: [p('widget_id'), p('part_id')], responses: ok(widget) },
      patch: {
        operationId: 'parts.update',
        summary: 'Update a part',
        parameters: [p('widget_id'), p('part_id'), q('color', { type: 'string' })],
        requestBody: { required: true, content: json({ type: 'object', properties: bodyProps }) },
        responses: ok(widget),
      },
      delete: { operationId: 'parts.delete', summary: 'Delete a part', parameters: [p('widget_id'), p('part_id')], responses: { '204': { description: 'Deleted' } } },
    },
    '/api/v1/files/{id}/content': {
      get: { operationId: 'files.content', summary: "Download a file's bytes", parameters: [p('id')], responses: { '200': { description: 'Success', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } },
    },
    // A plain route outside the registry: no operationId, no command.
    '/api/v1/ping': { get: { summary: 'ping', responses: ok({ type: 'object' }) } },
    // A query parameter with a reserved name: derivation fails for this operation only.
    '/api/v1/reports': { get: { operationId: 'reports.list', summary: 'List reports', parameters: [q('output', { type: 'string' })], responses: ok(page) } },
  },
})

export const metaDoc = (): any => ({
  openapi: '3.1.0',
  info: { title: 'fixture meta', version: '1' },
  paths: {
    '/meta/v1/me': { get: { operationId: 'me.get', summary: 'Who am I', responses: ok({ type: 'object', properties: { principal: { type: 'object' } } }) } },
    '/meta/v1/api-keys/{id}/revoke': { post: { operationId: 'api_keys.revoke', summary: 'Revoke an API key', parameters: [p('id')], responses: ok({ type: 'object' }) } },
  },
})

/** A `/.well-known/vibase` body for an instance at `origin`. */
export const wellKnown = (origin: string, over: Record<string, unknown> = {}) => ({
  api: `${origin}/api/v1`,
  openapi: { api: `${origin}/api/v1/openapi.json`, meta: `${origin}/meta/v1/openapi.json` },
  auth: null,
  ...over,
})
