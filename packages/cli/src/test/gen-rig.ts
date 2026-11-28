// Fixtures for the `vibase gen types` suites (DX712): the in-process app's documents for a workspace with a custom object
// and `extend` fields, and fixture projects that resolve `openapi-typescript` the way a developer's would.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDocuments } from '@vibase/sdk/generate'
import { defineCustomObject, parseSchemaFile } from '../../../api/src/index.js'
import { fakeInstance } from './harness.js'

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
export const SDK_DIR = here('../../../sdk')
export const SCHEMA_NAME = 'workspace.schema.json'
export const SCHEMA_TEXT = readFileSync(join(SDK_DIR, 'src/generate/fixtures', SCHEMA_NAME), 'utf8')
export const TOOL_VERSION = (
  JSON.parse(readFileSync(join(SDK_DIR, 'node_modules/openapi-typescript/package.json'), 'utf8')) as { version: string }
).version

export type Docs = { api: any; meta: any }
let memo: Promise<Docs> | undefined
/** The two documents of the production router for the schema fixture (a custom object, `__c` fields on contacts). */
export function workspaceDocuments(): Promise<Docs> {
  memo ??= (() => {
    const file = parseSchemaFile(SCHEMA_TEXT)
    return loadDocuments({
      definitions: Object.entries(file.objects).map(([key, declaration]) => defineCustomObject(key, declaration)),
      ...(file.extend ? { extend: file.extend } : {}),
    }) as Promise<Docs>
  })()
  return memo
}

/** A fake instance serving these documents (the discovery document and both OpenAPI documents). */
export const instanceOf = (docs: Docs, over: Parameters<typeof fakeInstance>[0] = {}) =>
  fakeInstance({ api: docs.api, meta: docs.meta, ...over })

const root = () => mkdtempSync(join(tmpdir(), 'vibase-gen-'))
const pkg = (dir: string, json: object) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json))
}
const real = (p: string) => realpathSync(p)
const SDK_TOOL = join(SDK_DIR, 'node_modules/openapi-typescript')

/** A project whose `node_modules/openapi-typescript` is the pinned 7.13.0 (typescript 5 resolves beside it, in the pnpm store). */
export function projectWithTool(): string {
  const dir = root()
  pkg(dir, { name: 'app' })
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(real(SDK_TOOL), join(dir, 'node_modules/openapi-typescript'))
  return dir
}

/** A project with no `openapi-typescript` anywhere it resolves from; the tool sits beside it, in a sibling folder. */
export function projectWithoutTool(): string {
  const base = root()
  const other = join(base, 'elsewhere')
  pkg(other, { name: 'other' })
  mkdirSync(join(other, 'node_modules'))
  symlinkSync(real(SDK_TOOL), join(other, 'node_modules/openapi-typescript'))
  const dir = join(base, 'app')
  pkg(dir, { name: 'app' })
  return dir
}

/** A project whose `openapi-typescript` is a stub of another major (it is refused before it is loaded). */
export function projectWithMajor(version: string): string {
  const dir = root()
  pkg(dir, { name: 'app' })
  const tool = join(dir, 'node_modules/openapi-typescript')
  pkg(tool, {
    name: 'openapi-typescript',
    version,
    type: 'module',
    main: './index.mjs',
    exports: { '.': './index.mjs', './*': './*' },
  })
  writeFileSync(join(tool, 'index.mjs'), 'throw new Error("must not be loaded")\n')
  return dir
}

/**
 * The real 7.13.0 copied beside whatever `typescript` the project holds: `with` the 7.0.2 of this workspace, or `none`.
 * openapi-typescript resolves its peer from its own real path, so it is copied (its dependencies are linked); this is how
 * `typescript` 7 (no compiler API) or no `typescript` fails for a developer. The observed failure under 7.0.2 is
 * `TypeError: Cannot read properties of undefined (reading 'createKeywordTypeNode')` when the module loads.
 */
export function projectWithToolOver(typescript: '7' | 'none'): string {
  const dir = root()
  pkg(dir, { name: 'app' })
  const modules = join(dir, 'node_modules')
  mkdirSync(modules)
  const store = dirname(real(SDK_TOOL))
  for (const name of ['@redocly', 'ansi-colors', 'change-case', 'parse-json', 'supports-color', 'yargs-parser'])
    symlinkSync(real(join(store, name)), join(modules, name))
  cpSync(real(SDK_TOOL), join(modules, 'openapi-typescript'), { recursive: true, dereference: true })
  if (typescript === '7') {
    const ts7 = real(here('../../node_modules/typescript'))
    symlinkSync(ts7, join(modules, 'typescript'))
  }
  return dir
}

export const exists = existsSync

/** A project whose `openapi-typescript` is a 7.x stand-in: the first document translates, the second one is refused (or none is). */
export function projectWithStub(failOnCall: number | undefined): string {
  const dir = root()
  pkg(dir, { name: 'app' })
  const tool = join(dir, 'node_modules/openapi-typescript')
  pkg(tool, {
    name: 'openapi-typescript',
    version: '7.99.0',
    type: 'module',
    main: './index.mjs',
    exports: { '.': './index.mjs', './*': './*' },
  })
  writeFileSync(
    join(tool, 'index.mjs'),
    `let calls = 0
export default async function openapiTS() {
  calls += 1
  if (calls === ${failOnCall ?? 0}) throw new Error('document ' + calls + ' refused by the translator')
  return { calls }
}
export const astToString = (ast) => 'export interface paths { stub: ' + ast.calls + ' }'
`,
  )
  return dir
}
