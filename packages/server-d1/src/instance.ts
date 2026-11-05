import { composeD1Worker, type D1WorkerEnv } from './compose.js'

// One composition per isolate, shared by the `fetch` and `scheduled` handlers and by the `MailSyncWorkflow`'s steps, so the migration state
// they all consult is read once (see composeD1Worker: only success is cached).
let worker: ReturnType<typeof composeD1Worker> | undefined

export const workerFor = (env: D1WorkerEnv): ReturnType<typeof composeD1Worker> => (worker ??= composeD1Worker(env))
