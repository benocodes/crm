import type { FilterArgs, FilterSpecs } from './filters.js'

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

/** The arguments with each filter parameter retyped as its `Filter` (DX608 D9); the document's own type for them is dropped. */
export type WithFilters<Args, F extends FilterSpecs> = Simplify<FilterArgs<Args, F>>

/** What an aggregate operation says about its fields (DX616 D2): the field names each function and `group_by` take (`never` for none), each field's filter kind, and the money fields. */
export interface AggregateShape {
  fields: { sum: string; avg: string; min: string; max: string; group_by: string }
  kinds: { [field: string]: string }
  money: { [field: string]: string }
}

type Fn = 'sum' | 'avg' | 'min' | 'max'
type AggParam = Fn | 'group_by'

/** One field name of a function's list, or a readonly array of them (D3). */
type OneOrMany<F extends string> = F | readonly [F, ...F[]]
/** `group_by`: one groupable field, or a tuple of one or two (the server's cap, CORE207 D3). */
type GroupArg<F extends string> = F | readonly [F] | readonly [F, F]

/** The argument object: the operation's filters as typed (DX608 D9), then each function that has fields. */
type AggregateArgs<Args, S extends AggregateShape> = Omit<Args, AggParam> & {
  [P in Fn as [S['fields'][P]] extends [never] ? never : P]?: OneOrMany<S['fields'][P]>
} & ([S['fields']['group_by']] extends [never] ? unknown : { group_by?: GroupArg<S['fields']['group_by']> })

/** The field names an argument value names. */
type Names<V> = Exclude<V, undefined> extends infer X ? (X extends readonly (infer E)[] ? E : X) : never
/** Whether the argument may be absent. */
type Maybe<V> = undefined extends V ? true : false

type Kind<S extends AggregateShape, F> = F extends keyof S['kinds'] ? S['kinds'][F] : never
type Num = number | null
type ValueOf<S extends AggregateShape, P extends Fn, F> = P extends 'sum' | 'avg'
  ? Num
  : Kind<S, F> extends 'integer'
    ? Num
    : string | null
type KeyOf<S extends AggregateShape, F> =
  | (Kind<S, F> extends 'integer' ? number : Kind<S, F> extends 'boolean' ? boolean : string)
  | null

type Flat<T> = { [K in keyof T]: T[K] } & Empty

/** The function keys asked in `A`: each as `{ [field]: value }`, optional when the argument may be undefined. */
type FunctionKeys<A, S extends AggregateShape> = {
  [P in Fn as P extends keyof A ? (true extends Maybe<A[P]> ? never : P) : never]: P extends keyof A
    ? { [F in Names<A[P]> & string]: ValueOf<S, P, F> }
    : never
} & {
  [P in Fn as P extends keyof A ? (true extends Maybe<A[P]> ? P : never) : never]?: P extends keyof A
    ? { [F in Names<A[P]> & string]: ValueOf<S, P, F> }
    : never
}

type FieldsOf<A, P extends Fn> = P extends keyof A ? Names<A[P]> & string : never
type MoneyOf<A, S extends AggregateShape> = Extract<FieldsOf<A, Fn>, keyof S['money'] & string>
type CurrencyKey<A, S extends AggregateShape> = [MoneyOf<A, S>] extends [never]
  ? unknown
  : { currency: { [F in MoneyOf<A, S>]: string | null } }

type Asked<A, S extends AggregateShape> = FunctionKeys<A, S> & CurrencyKey<A, S>

type Ungrouped<A, S extends AggregateShape> = Flat<{ count: number } & Asked<A, S>>
type Grouped<A, S extends AggregateShape, GB> = {
  count: number
  groups: Flat<{ key: { [F in Names<GB> & string]: KeyOf<S, F> }; count: number } & Asked<A, S>>[]
}

/** The answer typed by what was asked (D4): ungrouped, grouped, or the union where `group_by` may be undefined. */
export type AggregateAnswer<A, S extends AggregateShape> = 'group_by' extends keyof A
  ? [Exclude<A['group_by' & keyof A], undefined>] extends [never]
    ? Ungrouped<A, S>
    : true extends Maybe<A['group_by' & keyof A]>
      ? Ungrouped<A, S> | Grouped<A, S, A['group_by' & keyof A]>
      : Grouped<A, S, A['group_by' & keyof A]>
  : Ungrouped<A, S>

/** The one generic member of an aggregate operation (D3): `const` arguments decide the answer, and a name the operation does not take is refused. */
export type AggregateMethod<Args, S extends AggregateShape> = {
  (args?: undefined, options?: { signal?: AbortSignal }): Promise<Ungrouped<Record<never, never>, S>>
  <const A extends AggregateArgs<Args, S>>(
    args: A & { [K in Exclude<keyof A, keyof AggregateArgs<Args, S>>]: never },
    options?: { signal?: AbortSignal },
  ): Promise<AggregateAnswer<A, S>>
}
