// The slice of `cloudflare:workers` and `cloudflare:workflows` this example uses, typed here so `tsc` needs no `@cloudflare/workers-types`. Delete this file if you add that package.
declare module 'cloudflare:workers' {
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected ctx: unknown
    protected env: Env
    constructor(ctx: unknown, env: Env)
    abstract run(event: { payload: Params }, step: unknown): Promise<unknown>
  }
}
declare module 'cloudflare:workflows' {
  export class NonRetryableError extends Error {
    constructor(message: string, name?: string)
  }
}
