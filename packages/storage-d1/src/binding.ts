// The minimal D1 surface the runtime needs. Structural, so a Cloudflare `D1Database`, a Miniflare binding
// and a test double all fit; no Cloudflare SDK is imported ([[CORE35]] C3).

export interface D1ResultLike {
  readonly success: boolean
  readonly results?: readonly unknown[]
  readonly meta?: {
    readonly changes?: number
    readonly rows_read?: number
    readonly rows_written?: number
    readonly duration?: number
    readonly [key: string]: unknown
  }
}
export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike
  run(): Promise<D1ResultLike>
  all(): Promise<D1ResultLike>
  first(): Promise<Record<string, unknown> | null>
}
export interface D1Like {
  prepare(query: string): D1PreparedLike
  batch(statements: D1PreparedLike[]): Promise<D1ResultLike[]>
}
