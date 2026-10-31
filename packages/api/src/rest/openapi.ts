import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Operation } from '../registry.js'
import { fullPath } from '../surfaces.js'
import type { AppEnv } from './app.js'

/** `/tasks/{id}` -> `/tasks/:id`. */
export const honoPath = (path: string): string => path.replace(/\{(\w+)\}/g, ':$1')

/** Describes one operation in the OpenAPI document; routing and validation live in the adapter. */
export function documentOperation(app: OpenAPIHono<AppEnv>, op: Operation): void {
  const { request, response } = op
  const json = (schema: unknown) => ({ content: { 'application/json': { schema } } })
  app.openAPIRegistry.registerPath({
    method: op.method,
    path: fullPath(op),
    operationId: op.name,
    summary: op.summary,
    description: op.description,
    tags: op.tags,
    security: [{ bearerAuth: [] }],
    request: {
      params: request?.params,
      query: request?.query,
      body: request?.body ? { required: true, ...json(request.body) } : undefined,
    },
    responses: {
      [response.status]: {
        description: response.status === 204 ? 'No content' : 'Success',
        ...(op.output === 'binary' ? { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } : response.schema ? json(response.schema) : {}),
      },
    },
  } as never)
}

export function registerSecurityScheme(app: OpenAPIHono<AppEnv>): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer' })
}
