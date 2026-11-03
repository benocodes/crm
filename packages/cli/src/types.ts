/** Where the CLI touches the world. Tests pass fakes; `bin.ts` passes the process. */
export interface Sink {
  isTTY: boolean
  write(chunk: string | Uint8Array): void | Promise<void>
}
export interface Deps {
  fetch: typeof fetch
  env: Record<string, string | undefined>
  stdout: Sink
  stderr: Sink
  /** Reads all of stdin as text. */
  readStdin(): Promise<string>
  stdinIsTTY: boolean
  /** Milliseconds since the epoch. */
  now(): number
  /** Waits `ms` (device-login polling, lock waits). Tests pass a fake that moves their clock. */
  sleep(ms: number): Promise<void>
  homedir: string
  version: string
}

export type JsonSchema = { [key: string]: unknown }

/** An operation of the merged documents, references resolved, reduced to what commands need ([[API6]] D7). */
export interface Operation {
  id: string
  /** The document it came from. */
  source: 'api' | 'meta'
  method: string
  path: string
  summary: string
  parameters: { name: string; in: 'path' | 'query'; required: boolean; schema: JsonSchema; description?: string }[]
  /** `null`: no request body. `schema: null`: a body that is not JSON (not supported by derived commands). */
  body: { required: boolean; schema: JsonSchema | null } | null
  /** The success response has content and none of it is `application/json` (D14). */
  binary: boolean
  /** A list: an `after` query parameter and a `next_cursor` in the response (`--all`). */
  paginated: boolean
}

export type FlagType = 'string' | 'integer' | 'number' | 'boolean' | 'json'
export interface FlagSpec {
  /** The flag without dashes, kebab-case. */
  name: string
  /** The query parameter or body property it sets. */
  prop: string
  where: 'query' | 'body'
  type: FlagType
  enum?: string[]
  required: boolean
  description?: string
}
export interface Command {
  operationId: string
  resource: string
  action: string
  method: string
  path: string
  summary: string
  pathParams: string[]
  flags: FlagSpec[]
  /** Properties reachable only through `--data` (reserved or colliding names). */
  dataOnly: string[]
  hasBody: boolean
  bodyRequired: boolean
  binary: boolean
  paginated: boolean
  /** Why the command cannot run, when derivation failed for this operation. */
  error?: string
}
/** What a command line asks of one request. */
export interface Invocation {
  /** The path with its parameters filled in and percent-encoded. */
  path: string
  query: [string, string][]
  body?: unknown
  all: boolean
  output?: string
}
