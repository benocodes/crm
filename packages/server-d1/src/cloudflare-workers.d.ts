// The slice of `cloudflare:workers` this package uses. The real module exists only inside workerd (and wrangler's bundler); typing it here keeps
// `tsc` free of `@workers-types` for the one class we extend.
declare module 'cloudflare:workers' {
  /** The request-scoped `waitUntil` of the running invocation (the module-level export; [[CORE304]] D4). */
  export function waitUntil(promise: Promise<unknown>): void
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected ctx: unknown
    protected env: Env
    constructor(ctx: unknown, env: Env)
    abstract run(event: { payload: Params }, step: unknown): Promise<unknown>
  }
}
