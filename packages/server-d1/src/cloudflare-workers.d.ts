// The slice of `cloudflare:workers` this package uses. The real module exists only inside workerd (and wrangler's bundler); typing it here keeps
// `tsc` free of `@workers-types` for the one class we extend.
declare module 'cloudflare:workers' {
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected ctx: unknown
    protected env: Env
    constructor(ctx: unknown, env: Env)
    abstract run(event: { payload: Params }, step: unknown): Promise<unknown>
  }
}
