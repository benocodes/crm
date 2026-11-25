/** Helper types the generated `BuiltInOperations` is written with: openapi-typescript's `operations` entry to the flat arguments, result and item (DX603 D3, D5). */

type Empty = Record<never, never>
type Simplify<T> = { [K in keyof T]: T[K] } & Empty

type Parameters_<Op, Place extends 'path' | 'query'> = Op extends { parameters: { [P in Place]?: infer X } }
  ? [NonNullable<X>] extends [never]
    ? Empty
    : NonNullable<X>
  : Empty

type Body<Op> = Op extends { requestBody?: infer R }
  ? [NonNullable<R>] extends [never]
    ? Empty
    : NonNullable<R> extends { content: { 'application/json': infer B } }
      ? B
      : Empty
  : Empty

/** Path, query and body fields in one object: the shape MCP tools and action requests already take. */
export type ArgsOf<Op> = Simplify<Parameters_<Op, 'path'> & Parameters_<Op, 'query'> & Body<Op>>

/** The parsed JSON body of the response with this status. */
export type ResultOf<Op, Status extends number> = Op extends {
  responses: { [S in Status]: { content: { 'application/json': infer R } } }
}
  ? R
  : never

/** One item of a paginated result's `data`. */
export type ItemOf<Result> = Result extends { data: readonly (infer I)[] } ? I : never
