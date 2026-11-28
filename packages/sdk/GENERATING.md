# Generating and maintaining the SDK

Maintainer notes for `packages/sdk`. They are not part of the published package: `README.md` is what customers read, and
`release:build` refuses a README that tells the reader to run a repository command ([[OPS693]] D3).

## Regeneration

`src/generated/operations.ts` (the table) and `src/generated/types.ts` (the types) are generated from the `api` and `meta`
OpenAPI documents, built in-process from the production router. **Any change to an operation or its schema regenerates them:**

```bash
pnpm -C packages/sdk generate
```

The drift test (`src/generate/drift.test.ts`) fails until the committed files match. The workspace-map fixture the type tests compile
(`src/generate/fixtures/workspace/`) has its own drift check in `src/generate/workspace.test.ts`; regenerate it from the repo root:

```bash
pnpm -C packages/sdk generate --schema packages/sdk/src/generate/fixtures/workspace.schema.json --out packages/sdk/src/generate/fixtures/workspace
```
The generator is the Node-only entry
`@vibase/sdk/generate`; the runtime never imports it. `openapi-typescript` (a 7.x devDependency) needs `typescript` 5.x, so
this package pins `typescript` 5.9.3 beside the workspace's 7.x.

## Generating a workspace's types

The built-in client types the built-ins only. A workspace's custom objects (`projects__c`) and `__c` fields on contacts,
companies, deals and tasks are declared in its schema file; the generator turns that workspace into a **full map**
(every operation, built-ins included) that `createClient` takes through `operations`. For a deployed instance use
`vibase gen types --out <dir>` (the CLI reads the instance's documents and runs the same core, `@vibase/sdk/emit`, with the `openapi-typescript` 7 of the project it runs in; this script no longer fetches them). The repo script builds the
map from the schema file, in-process: it works offline, before a redeploy:

```bash
pnpm -C packages/sdk generate --schema ./vibase.schema.json --out apps/pipeline/src/vibase
```

A relative `--schema` or `--out` resolves against the directory you ran the command from. `--out` is required with a source and
may not be this package's own `src/generated/`. The two files (`operations.ts`, `types.ts`) are deterministic: the header
names the command, the source (for `--schema` the file name and its SHA-256, the digest `/health.schema` reports) and the
documents' `info.version`, and there is no timestamp. Commit them and regenerate when the schema file or the release changes;
nothing checks at run time that the map matches the deployment.

```ts
import { createClient } from '@vibase/sdk'
import { workspaceOperations } from './vibase/operations.js'

const vibase = createClient({ url: 'https://crm.acme.example', auth: () => getToken(), operations: workspaceOperations })
await vibase.projects__c.list({ budget: { gte: 5000 } }) // a one-word custom object keeps its key
await vibase.sessionRecordings__c.list({ length_seconds: { gte: 30 } }) // `session_recordings__c`: the stem is camelCased, the `__c` suffix kept; argument keys stay snake_case
await vibase.contacts.update({ id, tier__c: 'gold' }) // 'platinum' is a type error
```

A custom object's namespace is its key with the stem camelCased and the `__c` suffix kept (`session_recordings__c` is
`vibase.sessionRecordings__c`); the arguments and the results keep the snake_case names of the API. The generator refuses two
operation ids that camelCase to the same member (`item_2__c` and `item2__c`), naming both.

`Client<WorkspaceOperations>` (from `./vibase/types.js`) is the type to pass around.
