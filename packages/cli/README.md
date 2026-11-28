# @vibase/cli

The `vibase` command line: every operation of a Vibase instance, as a command. Documentation: https://docs.vibase.ai.

Working on the CLI itself (building it, running it from the repo, device login, onboarding an agent account)? See [DEVELOPMENT.md](https://github.com/benocodes/crm/blob/main/packages/cli/DEVELOPMENT.md).

## Typed SDK maps

`vibase gen types --out <dir>` writes `operations.ts` and `types.ts` for the instance you are signed in to (or `--server <url>`): the typed map of its operations, custom objects and `__c` fields, for `createClient({ operations })` from `@vibase/sdk`. It needs `openapi-typescript` 7 (with `typescript` 5) in the project it runs in: `npm i -D @vibase/sdk openapi-typescript@7`. See the [SDK guide](https://docs.vibase.ai/guides/sdk/).
