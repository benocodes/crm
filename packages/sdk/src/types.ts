/** What the generator and the client share: the operation map (types) and the operation table (data), DX603 D5 and D12. */

/** One operation of a map: its member names, its flat arguments, its result and whether it pages or may be proposed. */
export interface OperationShape {
  /** The client namespace (`deals`, `actionRequests`): the operation id's first part, camelCased (D4). */
  namespace: string
  /** The method name in that namespace (`moveStage`). Never `all` or `propose`. */
  method: string
  /** The flat arguments: path, query and body fields in one object (D5). */
  args: object
  /** The success result as the wire carries it: the parsed JSON body, `undefined` for a 204, `Response` for a binary one. */
  result: unknown
  /** A paginated operation's item type (`data[number]`); absent otherwise. */
  item?: unknown
  proposable: boolean
  paginated: boolean
}

/** The map: operation id to its shape. The generator writes `BuiltInOperations`; DX604 writes a per-workspace one. */
export type OperationMap = { [operationId: string]: OperationShape }

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type FieldPlace = 'path' | 'query' | 'body'

/** One row of the runtime table: where the operation lives and where each argument goes. */
export interface OperationEntry<O extends OperationShape = OperationShape> {
  readonly namespace: O['namespace']
  readonly method: O['method']
  readonly http: HttpMethod
  /** The path template, `{name}` for a path field: `/api/v1/deals/{id}`. */
  readonly path: string
  /** Every declared argument and where it goes. A name not listed goes to the body when the operation has one. */
  readonly fields: Readonly<Record<string, FieldPlace>>
  /** Whether the operation has a JSON request body. */
  readonly body: boolean
  /** `json` the parsed body, `empty` a 204 (resolves undefined), `binary` the checked `Response`. */
  readonly output: 'json' | 'empty' | 'binary'
  readonly paginated: O['paginated']
  readonly proposable: O['proposable']
  /** Query parameters that are column filters (`x-vibase-filter`): their kind and operators. */
  readonly filters: Readonly<Record<string, { readonly kind: string; readonly operators: readonly string[] }>>
}

/** The runtime table, typed by the map it was generated with, so `createClient` infers the map from it. */
export type OperationTable<Ops extends OperationMap> = { readonly [K in keyof Ops]: OperationEntry<Ops[K]> }

export interface CallOptions {
  signal?: AbortSignal
}

/** A method: the flat arguments (omitted when none is required) and an optional `{ signal }`. */
export type Method<O extends OperationShape> = {} extends O['args']
  ? (args?: O['args'], options?: CallOptions) => Promise<O['result']>
  : (args: O['args'], options?: CallOptions) => Promise<O['result']>

/** The client: one namespace per resource prefix, one method per operation (`.all` and `.propose` come in DX608). */
export type Client<Ops extends OperationMap> = {
  [N in Ops[keyof Ops]['namespace']]: {
    [K in keyof Ops as Ops[K]['namespace'] extends N ? Ops[K]['method'] : never]: Method<Ops[K]>
  }
}

/** A credential: the token, or a function called before every request; `null` means signed out (D6). */
export type Auth = string | (() => string | null | Promise<string | null>)

export interface ClientOptions<Ops extends OperationMap> {
  /** The deployment's origin, `https://api.acme.example`. Required: one deployment per organisation. */
  url: string
  auth: Auth
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** The operation table; defaults to the built-ins. Passing a generated table infers the map. */
  operations?: OperationTable<Ops>
}
