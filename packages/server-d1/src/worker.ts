import { composeD1Worker, type D1WorkerEnv } from './compose.js'

// One composition per isolate: only success is cached (see composeD1Worker).
let worker: ReturnType<typeof composeD1Worker> | undefined

export default {
  fetch: (req: Request, env: D1WorkerEnv): Promise<Response> => (worker ??= composeD1Worker(env)).fetch(req),
}
