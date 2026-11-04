import type { Context } from 'hono'
import { ApiError } from '../errors.js'
import type { AppEnv } from '../rest/app.js'
import type { Operation, OperationInput, Registry } from '../registry.js'
import { INSTRUCTIONS } from './instructions.js'
import { deriveTools, isVisible, splitArguments } from './tools.js'

/** [[API106]] D2: newest first; the answer to an `initialize` naming anything else. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const
/** [[API106]] D1: the one endpoint, at the API origin's root. */
export const MCP_PATH = '/mcp'
/** D21: the cap on one JSON-RPC message. */
export const MAX_BODY_BYTES = 1024 * 1024

export interface McpDeps {
  registry: Registry
  /** `serverInfo.version`: the Worker version. */
  version: string
  /** A single-workspace composition: `me.get` answers agents (D6). */
  workspace: boolean
  /** The REST executor (D12): adapter validation, then scope checks, the unit and error mapping, as `run` does. */
  execute: (c: Context<AppEnv>, op: Operation, input: OperationInput) => Promise<unknown>
}

type Id = string | number | null
const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } })
const httpError = (c: Context<AppEnv>, status: 400 | 405 | 413 | 415, code: string, message: string, headers?: Record<string, string>) =>
  c.json({ error: { code, message } }, status, headers)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads the body, refusing past the cap without buffering the rest. `undefined` means over the cap. */
async function readCapped(req: Request): Promise<string | undefined> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const ch of chunks) {
    all.set(ch, at)
    at += ch.byteLength
  }
  return new TextDecoder().decode(all)
}

/** D1: `GET`, `DELETE` and anything else but `POST`. */
export const mcpMethodNotAllowed = (c: Context<AppEnv>) => httpError(c, 405, 'method_not_allowed', 'POST a JSON-RPC message to this endpoint', { Allow: 'POST' })

/**
 * D1, D3, D10: one stateless JSON-RPC message per `POST`. A JSON-RPC error is answered with HTTP 200 and the error in the body
 * (the reference client turns any non-2xx into a transport error and never reads the body); the transport's own refusals are
 * plain HTTP errors with the REST error body.
 */
export function mcpPost(deps: McpDeps) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (type !== 'application/json') return httpError(c, 415, 'unsupported_media_type', 'Content-Type must be application/json')
    const text = await readCapped(c.req.raw)
    if (text === undefined) return c.json({ error: { code: 'payload_too_large', message: 'a message is at most 1 MiB' } }, 413)
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return c.json(rpcError(null, -32700, 'parse error'))
    }
    if (Array.isArray(message)) return c.json(rpcError(null, -32600, 'batches are not supported'))
    if (!isObject(message) || message.jsonrpc !== '2.0') return c.json(rpcError(null, -32600, 'not a JSON-RPC 2.0 message'))
    const hasId = 'id' in message
    const id = message.id
    if (hasId && typeof id !== 'string' && typeof id !== 'number') return c.json(rpcError(null, -32600, 'id must be a string or a number'))
    if (typeof message.method !== 'string') {
      // A response from the client (to a server request we never send) is accepted and ignored.
      if (hasId && ('result' in message || 'error' in message)) return c.body(null, 202)
      return c.json(rpcError(hasId ? (id as Id) : null, -32600, 'missing method'))
    }
    const method = message.method
    const version = c.req.header('mcp-protocol-version')
    if (method !== 'initialize' && version !== undefined && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      return httpError(c, 400, 'unsupported_protocol_version', `MCP-Protocol-Version ${version} is not supported; use ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`)
    }
    if (!hasId) return c.body(null, 202) // notifications/initialized, notifications/cancelled and any other: nothing to answer
    const rid = id as Id
    const params = message.params
    switch (method) {
      case 'initialize': {
        const asked = isObject(params) ? params.protocolVersion : undefined
        const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).find((v) => v === asked) ?? SUPPORTED_PROTOCOL_VERSIONS[0]
        return c.json({
          jsonrpc: '2.0',
          id: rid,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'vibase', version: deps.version },
            instructions: INSTRUCTIONS,
          },
        })
      }
      case 'ping':
        return c.json({ jsonrpc: '2.0', id: rid, result: {} })
      case 'tools/list': {
        const principal = c.var.principal
        const tools = deriveTools(deps.registry)
          .filter((e) => isVisible(e.op, principal, deps.workspace))
          .map((e) => e.tool)
        return c.json({ jsonrpc: '2.0', id: rid, result: { tools } })
      }
      case 'tools/call': {
        if (!isObject(params) || typeof params.name !== 'string') return c.json(rpcError(rid, -32602, 'name is required'))
        const args = params.arguments ?? {}
        if (!isObject(args)) return c.json(rpcError(rid, -32602, 'arguments must be an object'))
        const entry = deriveTools(deps.registry).find((e) => e.tool.name === params.name)
        if (!entry) return c.json(rpcError(rid, -32602, `unknown tool ${params.name}`))
        return c.json({ jsonrpc: '2.0', id: rid, result: await callTool(c, deps, entry.op, args) })
      }
      default:
        return c.json(rpcError(rid, -32601, `method not found: ${method}`))
    }
  }
}

async function callTool(c: Context<AppEnv>, deps: McpDeps, op: Operation, args: Record<string, unknown>) {
  const text = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(value) })
  try {
    const value = await deps.execute(c, op, splitArguments(op, args))
    if (op.response.status === 204) return { content: [text({ ok: true })] }
    return { content: [text(value)], ...(isObject(value) ? { structuredContent: value } : {}) }
  } catch (err) {
    const body = err instanceof ApiError ? err.toBody() : { error: { code: 'internal', message: 'internal error' } }
    if (!(err instanceof ApiError)) console.error('[api] unhandled tools/call', op.name, err)
    return { isError: true, content: [text(body)], structuredContent: body }
  }
}
