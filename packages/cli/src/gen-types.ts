import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { type EmitProfile, generateFiles, type Translator } from '@vibase/sdk/emit'
import { configPath, loadConfig, resolveConnection } from './config.js'
import { fetchDocuments } from './discovery.js'
import { CliError, usage } from './errors.js'
import { json } from './http.js'
import type { Deps } from './types.js'

export const GEN_TYPES_HELP = `vibase gen types --out <dir> [--server <url>] [--profile <name>]

Writes <dir>/operations.ts and <dir>/types.ts: the typed map of this instance's operations, custom objects and __c fields, for createClient({ operations }) from @vibase/sdk.
Needs openapi-typescript 7 (with typescript 5) in the project it runs in: npm i -D @vibase/sdk openapi-typescript@7. Reads the public documents, with no login needed; replaces both files.
Exit 2: usage or missing dependency (nothing fetched or written); exit 1: the instance, the network or the generation failed (files left as they were).
`

const TOOL = 'openapi-typescript'
const INSTALL = `npm i -D ${TOOL}@7`
const missing = (message: string) => new CliError(2, 'missing_dependency', message)

const readVersion = (file: string): string | undefined => {
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

/** The directory of the package `name` as Node resolves it from `from`, or undefined. */
function packageDir(from: string, name: string): string | undefined {
  const req = createRequire(join(from, 'noop.cjs'))
  try {
    return dirname(req.resolve(`${name}/package.json`))
  } catch {
    // the package may not export its manifest: find it from its entry
  }
  try {
    let dir = dirname(req.resolve(name))
    for (; ; dir = dirname(dir)) {
      try {
        if ((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name === name)
          return dir
      } catch {
        // no manifest here
      }
      if (dirname(dir) === dir) return undefined
    }
  } catch {
    return undefined
  }
}

/**
 * [[DX694]] D3: `openapi-typescript` 7 from the project (`cwd`), before any request. The module is loaded from a computed URL, so the
 * bundle holds neither it nor `typescript` (D8).
 */
async function loadTranslator(cwd: string): Promise<{ translate: Translator; version: string }> {
  const dir = packageDir(cwd, TOOL)
  const version = dir ? readVersion(join(dir, 'package.json')) : undefined
  if (!dir || !version)
    throw missing(`vibase gen types needs ${TOOL} 7 in this project (searched from ${cwd}): ${INSTALL}`)
  if (version.split('.')[0] !== '7')
    throw missing(
      `vibase gen types needs ${TOOL} 7 in this project, found ${version} (searched from ${cwd}): ${INSTALL}`,
    )
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    main?: string
    exports?: { '.'?: string | { import?: string } }
  }
  const dot = manifest.exports?.['.']
  const entry = (typeof dot === 'string' ? dot : dot?.import) ?? manifest.main ?? 'index.js'
  const cannotLoad = (why: string) => {
    const ts = packageDir(dir, 'typescript')
    const tsVersion = ts ? readVersion(join(ts, 'package.json')) : undefined
    return missing(
      `vibase gen types: ${TOOL} ${version} (${dir}) cannot load TypeScript's compiler API (${why}); ` +
        `${tsVersion ? `typescript ${tsVersion} resolves from it` : 'no typescript resolves from it'}, ` +
        `and ${TOOL} 7 needs typescript 5 where it resolves: npm i -D typescript@5`,
    )
  }
  let loaded: { default?: unknown; astToString?: unknown }
  try {
    loaded = await import(pathToFileURL(join(dir, entry)).href)
  } catch (e) {
    throw cannotLoad(e instanceof Error ? e.message : 'load failed')
  }
  const { default: openapiTS, astToString } = loaded
  if (typeof openapiTS !== 'function' || typeof astToString !== 'function')
    throw cannotLoad('it does not export what gen types uses')
  return { translate: async (document) => astToString(await openapiTS(document)), version }
}

const infoVersion = (document: unknown): string => {
  const v = (document as { info?: { version?: unknown } } | null)?.info?.version
  return typeof v === 'string' ? v : 'unknown'
}
const isDocument = (d: unknown) =>
  typeof d === 'object' &&
  d !== null &&
  typeof (d as { paths?: unknown }).paths === 'object' &&
  (d as { paths?: unknown }).paths !== null &&
  !Array.isArray(d)

/** Each file goes to a temporary sibling first; the renames come only once both are written. */
function writeBoth(dir: string, files: [string, string][]): void {
  const temps: [string, string][] = []
  try {
    for (const [name, text] of files) {
      const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
      temps.push([tmp, join(dir, name)])
      writeFileSync(tmp, text)
    }
    for (const [tmp, target] of temps) renameSync(tmp, target)
  } catch (e) {
    for (const [tmp] of temps)
      try {
        unlinkSync(tmp)
      } catch {
        // already renamed or never written
      }
    throw new CliError(1, 'write_failed', `could not write ${dir}: ${e instanceof Error ? e.message : 'write failed'}`)
  }
}

/** `vibase gen types --out <dir>` ([[DX694]] D1 to D6): the workspace's two SDK type files, from the instance's own documents. */
export async function genTypes(words: string[], args: string[], help: boolean, deps: Deps): Promise<number> {
  if (help) {
    await deps.stdout.write(GEN_TYPES_HELP)
    return 0
  }
  if (words[0] !== 'gen' || words[1] !== 'types')
    throw usage(
      `unknown command "${words.join(' ')}": the one generator is \`vibase gen types --out <dir>\` (vibase gen types --help)`,
    )
  let values: { out?: string; server?: string; profile?: string }
  try {
    const parsed = parseArgs({
      args,
      options: { out: { type: 'string' }, server: { type: 'string' }, profile: { type: 'string' } },
      allowPositionals: true,
    })
    if (parsed.positionals.length > 0)
      throw new Error(`gen types takes no positional arguments (got ${parsed.positionals.join(' ')})`)
    values = parsed.values
  } catch (e) {
    throw usage(
      `${e instanceof Error ? e.message : 'bad arguments'}. Usage: vibase gen types --out <dir> [--server <url>] [--profile <name>]`,
    )
  }
  if (!values.out) throw usage('gen types needs --out <dir>: where operations.ts and types.ts are written')
  const cwd = deps.cwd ?? process.cwd()
  const out = resolve(cwd, values.out)
  try {
    if (!statSync(out).isDirectory()) throw usage(`--out ${values.out} exists and is not a directory`)
  } catch (e) {
    if (e instanceof CliError) throw e
    // absent: it is created
  }
  const conn = resolveConnection(loadConfig(configPath(deps)), values, deps.env, { needKey: false })
  const tool = await loadTranslator(cwd)
  const documents = await fetchDocuments(conn.server, deps)
  for (const [name, d] of [
    ['api', documents.api],
    ['meta', documents.meta],
  ] as const)
    if (!isDocument(d))
      throw usage(`the ${name} document of ${conn.server} is not an OpenAPI document with paths`, 'discovery_failed')
  const api = infoVersion(documents.api)
  const profile: EmitProfile = {
    header: `// GENERATED by \`vibase gen types\` from this instance's api and meta OpenAPI documents. Do not edit.
// Source: ${conn.server}
// Documents: info.version ${api} (api), ${infoVersion(documents.meta)} (meta). ${TOOL} ${tool.version}. Regenerate after a schema file or release change.
`,
    operationsName: 'workspaceOperations',
    mapName: 'WorkspaceOperations',
    tableFrom: '@vibase/sdk',
    helpersFrom: '@vibase/sdk',
  }
  let generated: { operations: string; types: string }
  try {
    generated = await generateFiles(documents, profile, tool.translate)
  } catch (e) {
    throw new CliError(1, 'generation_failed', e instanceof Error ? e.message : 'generation failed')
  }
  try {
    mkdirSync(out, { recursive: true })
  } catch (e) {
    throw usage(`cannot create --out ${values.out}: ${e instanceof Error ? e.message : 'failed'}`)
  }
  writeBoth(out, [
    ['operations.ts', generated.operations],
    ['types.ts', generated.types],
  ])
  await json(deps, 'stdout', {
    server: conn.server,
    version: api,
    files: [join(out, 'operations.ts'), join(out, 'types.ts')],
  })
  return 0
}
