import { waitUntil } from 'cloudflare:workers'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { readSchemaFile } from './schema-file-module.js'
// [[CORE315]] D27, [[CORE543]] P7: the attached file, a Text module a deploy stages beside the Worker (the repo's builds resolve the checked-in empty default).
import { schemaFileText } from './schema-file-text.js'

// One composition per isolate, shared by the `fetch` and `scheduled` handlers and by the `MailSyncWorkflow`'s steps, so the migration state
// they all consult is read once (see composeD1Worker: only success is cached).
let worker: ReturnType<typeof composeD1Worker> | undefined

// [[CORE304]] D4: the composition is handed `cloudflare:workers`' request-scoped `waitUntil` (the self-service reset send is scheduled with it). It is injected here, in the Worker-only entry module, so `compose.ts` stays Node-testable.
// [[CORE315]] D12, D28: the file is parsed once with the validator the tooling used; its definitions and extension fields reach every registry the composition builds, and a file that cannot be loaded fails every route but `/health` closed.
export const workerFor = (env: D1WorkerEnv): ReturnType<typeof composeD1Worker> => {
  if (worker) return worker
  const schemaFile = readSchemaFile(schemaFileText)
  if (schemaFile.error)
    console.error(
      `[schema] the attached file is invalid (${schemaFile.error.rule} at ${schemaFile.error.path || 'the file'})`,
    )
  return (worker = composeD1Worker(env, {
    waitUntil,
    schemaFile,
    ...(schemaFile.definitions.length > 0 ? { definitions: schemaFile.definitions } : {}),
    // [[CORE561]] D12: the file's `extend`, the one switch for every registry, the rail, mail sync and form ingress.
    ...(schemaFile.extend ? { extend: schemaFile.extend } : {}),
  }))
}
