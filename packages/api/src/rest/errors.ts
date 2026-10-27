import type { Context } from 'hono'
import { ApiError } from '../errors.js'

const body = (code: string, message: string) => ({ error: { code, message } })

/** Renders every failure as `{ error: { code, message } }`; unexpected errors are masked and logged. */
export function renderError(err: unknown, c: Context<any>): Response {
  if (err instanceof ApiError) return c.json(err.toBody(), err.status)
  console.error('[api] unhandled', c.req.method, c.req.path, err)
  return c.json(body('internal', 'internal error'), 500)
}

export function renderNotFound(c: Context<any>): Response {
  return c.json(body('not_found', 'no such route'), 404)
}
